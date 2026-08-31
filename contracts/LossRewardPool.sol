// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/**
 * @dev Cryptographic Merkle proof verification matching OpenZeppelin standard.
 */
library MerkleProof {
    function verify(
        bytes32[] calldata proof,
        bytes32 root,
        bytes32 leaf
    ) internal pure returns (bool) {
        bytes32 computedHash = leaf;
        for (uint256 i = 0; i < proof.length; i++) {
            bytes32 proofElement = proof[i];
            if (computedHash <= proofElement) {
                computedHash = _efficientHash(computedHash, proofElement);
            } else {
                computedHash = _efficientHash(proofElement, computedHash);
            }
        }
        return computedHash == root;
    }

    function _efficientHash(bytes32 a, bytes32 b) private pure returns (bytes32 value) {
        assembly {
            mstore(0x00, a)
            mstore(0x20, b)
            value := keccak256(0x00, 0x40)
        }
    }
}

/**
 * @title LossRewardPool
 * @notice Holds native ETH loss-reward funds for Incentifi launch tokens.
 *         Verifies Merkle proofs published per hourly epoch and pays native ETH to claimants.
 *         Maintains strictly isolated per-token vault accounting.
 */
contract LossRewardPool {
    address public owner;
    address public operator;

    // Token => Total ETH ever deposited
    mapping(address => uint256) public totalDeposited;
    // Token => Total ETH allocated to published Merkle epochs
    mapping(address => uint256) public totalAllocated;
    // Token => Total ETH claimed by users
    mapping(address => uint256) public totalClaimed;

    // Token => EpochId => Merkle Root
    mapping(address => mapping(uint256 => bytes32)) public epochMerkleRoots;
    // Token => EpochId => Allocated ETH amount
    mapping(address => mapping(uint256 => uint256)) public epochAllocatedAmounts;
    // Token => EpochId => Account => Claimed Status
    mapping(address => mapping(uint256 => mapping(address => bool))) public hasClaimed;

    uint256 private _status;
    uint256 private constant _NOT_ENTERED = 1;
    uint256 private constant _ENTERED = 2;

    event RewardDeposited(address indexed token, address indexed sender, uint256 amount);
    event EpochRootPublished(
        address indexed token,
        uint256 indexed epochId,
        bytes32 merkleRoot,
        uint256 allocatedAmount
    );
    event RewardClaimed(
        address indexed token,
        uint256 indexed epochId,
        address indexed claimant,
        uint256 amount
    );
    event OperatorUpdated(address indexed previousOperator, address indexed newOperator);
    event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);

    error Unauthorized();
    error ZeroAddress();
    error ZeroAmount();
    error EpochAlreadyPublished();
    error InsufficientUnallocatedPool();
    error InvalidMerkleRoot();
    error EpochNotPublished();
    error AlreadyClaimed();
    error InvalidProof();
    error EthTransferFailed();
    error ArrayLengthMismatch();
    error ReentrancyGuardReentrantCall();

    modifier onlyOwner() {
        if (msg.sender != owner) revert Unauthorized();
        _;
    }

    modifier onlyOperator() {
        if (msg.sender != operator && msg.sender != owner) revert Unauthorized();
        _;
    }

    modifier nonReentrant() {
        if (_status == _ENTERED) revert ReentrancyGuardReentrantCall();
        _status = _ENTERED;
        _;
        _status = _NOT_ENTERED;
    }

    constructor(address _operator) {
        owner = msg.sender;
        operator = _operator == address(0) ? msg.sender : _operator;
        _status = _NOT_ENTERED;
        emit OwnershipTransferred(address(0), msg.sender);
        emit OperatorUpdated(address(0), operator);
    }

    /**
     * @notice Deposit fee ETH from swap router for a specific token.
     * @param token Address of the Incentifi token.
     */
    function depositReward(address token) external payable {
        if (token == address(0)) revert ZeroAddress();
        if (msg.value == 0) revert ZeroAmount();

        totalDeposited[token] += msg.value;
        emit RewardDeposited(token, msg.sender, msg.value);
    }

    /**
     * @notice Query unallocated ETH balance available for future epoch distributions.
     * @param token Address of the Incentifi token.
     */
    function getUnallocatedBalance(address token) external view returns (uint256) {
        uint256 deposited = totalDeposited[token];
        uint256 allocated = totalAllocated[token];
        return deposited > allocated ? deposited - allocated : 0;
    }

    /**
     * @notice Publish an hourly Merkle root for a token's reward epoch.
     * @param token Address of the token.
     * @param epochId Sequential epoch identifier.
     * @param merkleRoot Cryptographic root of all eligible holder claims.
     * @param allocatedAmount Total ETH allocated for this epoch (after proportional scaling).
     */
    function setEpochMerkleRoot(
        address token,
        uint256 epochId,
        bytes32 merkleRoot,
        uint256 allocatedAmount
    ) external onlyOperator {
        if (token == address(0)) revert ZeroAddress();
        if (merkleRoot == bytes32(0)) revert InvalidMerkleRoot();
        if (epochMerkleRoots[token][epochId] != bytes32(0)) revert EpochAlreadyPublished();

        uint256 unallocated = totalDeposited[token] - totalAllocated[token];
        if (allocatedAmount > unallocated) revert InsufficientUnallocatedPool();

        totalAllocated[token] += allocatedAmount;
        epochMerkleRoots[token][epochId] = merkleRoot;
        epochAllocatedAmounts[token][epochId] = allocatedAmount;

        emit EpochRootPublished(token, epochId, merkleRoot, allocatedAmount);
    }

    /**
     * @notice Claim native ETH reward for a single epoch.
     * @param token Address of the token.
     * @param epochId Epoch identifier.
     * @param amount ETH amount allocated to caller in this epoch.
     * @param merkleProof Merkle sibling hashes proving membership.
     */
    function claimReward(
        address token,
        uint256 epochId,
        uint256 amount,
        bytes32[] calldata merkleProof
    ) external nonReentrant {
        _claimEpoch(token, epochId, amount, merkleProof, msg.sender);
        totalClaimed[token] += amount;

        (bool success, ) = msg.sender.call{value: amount}("");
        if (!success) revert EthTransferFailed();
    }

    /**
     * @notice Batch claim native ETH rewards across multiple past epochs in one transaction.
     * @param token Address of the token.
     * @param epochIds Array of epoch IDs.
     * @param amounts Array of amounts corresponding to each epoch.
     * @param merkleProofs Array of Merkle proofs for each epoch.
     */
    function claimBatch(
        address token,
        uint256[] calldata epochIds,
        uint256[] calldata amounts,
        bytes32[][] calldata merkleProofs
    ) external nonReentrant {
        if (epochIds.length != amounts.length || epochIds.length != merkleProofs.length) {
            revert ArrayLengthMismatch();
        }

        uint256 totalPayout = 0;
        for (uint256 i = 0; i < epochIds.length; i++) {
            _claimEpoch(token, epochIds[i], amounts[i], merkleProofs[i], msg.sender);
            totalPayout += amounts[i];
        }

        totalClaimed[token] += totalPayout;

        (bool success, ) = msg.sender.call{value: totalPayout}("");
        if (!success) revert EthTransferFailed();
    }

    function _claimEpoch(
        address token,
        uint256 epochId,
        uint256 amount,
        bytes32[] calldata merkleProof,
        address claimant
    ) internal {
        bytes32 root = epochMerkleRoots[token][epochId];
        if (root == bytes32(0)) revert EpochNotPublished();
        if (hasClaimed[token][epochId][claimant]) revert AlreadyClaimed();

        bytes32 leaf = keccak256(
            bytes.concat(keccak256(abi.encode(token, epochId, claimant, amount)))
        );
        if (!MerkleProof.verify(merkleProof, root, leaf)) revert InvalidProof();

        hasClaimed[token][epochId][claimant] = true;

        emit RewardClaimed(token, epochId, claimant, amount);
    }

    function setOperator(address _operator) external onlyOwner {
        if (_operator == address(0)) revert ZeroAddress();
        emit OperatorUpdated(operator, _operator);
        operator = _operator;
    }

    function transferOwnership(address newOwner) external onlyOwner {
        if (newOwner == address(0)) revert ZeroAddress();
        emit OwnershipTransferred(owner, newOwner);
        owner = newOwner;
    }

    receive() external payable {}
}
