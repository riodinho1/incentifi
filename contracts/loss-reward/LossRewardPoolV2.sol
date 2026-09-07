// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {ILossRewardPoolV2} from "./interfaces/ILossRewardPoolV2.sol";
import {IRewardSwapper} from "./interfaces/IRewardSwapper.sol";
import {IRobinhoodStock, IRobinhoodStockFactory, IRobinhoodAccessControlsRegistry} from "./interfaces/IRobinhoodStock.sol";

/**
 * @dev Cryptographic Merkle proof verification matching OpenZeppelin standard. Identical to V1.
 */
library MerkleProof {
    function verify(bytes32[] calldata proof, bytes32 root, bytes32 leaf) internal pure returns (bool) {
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
 * @title LossRewardPoolV2
 * @notice Holds native ETH loss-reward funds for Incentifi launch tokens and pays claims in ETH
 *         (exactly as V1) or, when the token's creator selected one at launch, in a Robinhood
 *         stock token bought at claim time.
 *
 *         Economics of a stock payout, stated once: the claimant's ETH allocation is spent buying
 *         the selected stock at the moment of the claim, and the claimant receives whatever it
 *         buys. There is no dollar-value promise, no oracle price, no shortfall liability. If the
 *         stock cannot be delivered, the claimant receives the ETH allocation instead.
 *
 * @dev    Custody invariant: THIS CONTRACT NEVER HOLDS STOCK. The swap adapter delivers the
 *         stock from the Uniswap pool straight to the claimant; this contract only ever custodies
 *         ETH. Stock tokens are pausable, block-listable and admin-burnable by their issuer, so
 *         any custody here would be a liability.
 *
 *         V1 compatibility: depositReward, setEpochMerkleRoot, claimReward, claimBatch, the leaf
 *         format keccak256(bytes.concat(keccak256(abi.encode(token, epochId, claimant, amount)))),
 *         the operator model and every V1 event/error are unchanged, so the worker changes are
 *         address-only.
 *
 *         V2 fixes: receive() reverts (bare ETH is unattributable), and a per-epoch claimed cap
 *         makes per-token accounting strict: claims <= sum(allocations) <= deposits per token, so
 *         address(this).balance == sum over tokens of (totalDeposited - totalClaimed), exactly.
 */
contract LossRewardPoolV2 is ILossRewardPoolV2 {
    // ------------------------------------------------------------------ V1 state (same names)
    address public owner;
    address public operator;

    mapping(address => uint256) public totalDeposited;
    mapping(address => uint256) public totalAllocated;
    mapping(address => uint256) public totalClaimed;

    mapping(address => mapping(uint256 => bytes32)) public epochMerkleRoots;
    mapping(address => mapping(uint256 => uint256)) public epochAllocatedAmounts;
    mapping(address => mapping(uint256 => mapping(address => bool))) public hasClaimed;

    uint256 private _status;
    uint256 private constant _NOT_ENTERED = 1;
    uint256 private constant _ENTERED = 2;

    // ------------------------------------------------------------------ V2 state
    IRobinhoodStockFactory public immutable stockFactory;
    IRobinhoodAccessControlsRegistry public immutable accessRegistry;

    /// @notice Strict accounting: ETH claimed against each epoch, capped at its allocation.
    mapping(address => mapping(uint256 => uint256)) public epochClaimedAmounts;

    struct TokenAsset {
        address asset;   // address(0) = ETH
        bool assetSet;   // written exactly once, at launch
        bool forcedEth;  // owner override, one-way
    }

    mapping(address => TokenAsset) private _tokenAssets;
    mapping(address => AssetRoute) private _routes;
    mapping(address => bool) public assetSetters;
    /// @notice Applies to the BATCH TOTAL of a claim, not per epoch.
    uint256 public minStockRewardWei;

    uint16 public constant MAX_DEVIATION_BPS_CAP = 2_000; // a route may never tolerate more than 20%
    uint32 public constant MIN_TWAP_WINDOW = 300;         // seconds

    // ------------------------------------------------------------------ modifiers
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

    constructor(address _operator, address _stockFactory, address _accessRegistry) {
        if (_stockFactory == address(0) || _accessRegistry == address(0)) revert ZeroAddress();
        owner = msg.sender;
        operator = _operator == address(0) ? msg.sender : _operator;
        stockFactory = IRobinhoodStockFactory(_stockFactory);
        accessRegistry = IRobinhoodAccessControlsRegistry(_accessRegistry);
        _status = _NOT_ENTERED;
        emit OwnershipTransferred(address(0), msg.sender);
        emit OperatorUpdated(address(0), operator);
    }

    /// @dev Bare ETH is unattributable to any token, and a labelled sink would need a privileged
    ///      "attribute this" lever. Rejecting keeps the accounting invariant exact and loses nothing.
    receive() external payable {
        revert BareEthRejected();
    }

    // ================================================================== V1 surface (unchanged)
    function depositReward(address token) external payable {
        if (token == address(0)) revert ZeroAddress();
        if (msg.value == 0) revert ZeroAmount();
        totalDeposited[token] += msg.value;
        emit RewardDeposited(token, msg.sender, msg.value);
    }

    function getUnallocatedBalance(address token) external view returns (uint256) {
        uint256 deposited = totalDeposited[token];
        uint256 allocated = totalAllocated[token];
        return deposited > allocated ? deposited - allocated : 0;
    }

    function setEpochMerkleRoot(address token, uint256 epochId, bytes32 merkleRoot, uint256 allocatedAmount)
        external
        onlyOperator
    {
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

    /// @notice V1 signature. Reverts UseClaimAs when the effective payout is a stock (unless the
    ///         amount is below minStockRewardWei, in which case ETH is paid anyway).
    function claimReward(address token, uint256 epochId, uint256 amount, bytes32[] calldata merkleProof)
        external
        nonReentrant
    {
        _claimEpoch(token, epochId, amount, merkleProof, msg.sender);
        _settle(token, msg.sender, amount, 0, type(uint256).max, true);
    }

    /// @notice V1 signature. See claimReward.
    function claimBatch(address token, uint256[] calldata epochIds, uint256[] calldata amounts, bytes32[][] calldata merkleProofs)
        external
        nonReentrant
    {
        uint256 total = _claimMany(token, epochIds, amounts, merkleProofs);
        _settle(token, msg.sender, total, 0, type(uint256).max, true);
    }

    // ================================================================== V2 claims
    function claimRewardAs(address token, uint256 epochId, uint256 amount, bytes32[] calldata merkleProof, uint256 minAssetOut, uint256 deadline)
        external
        nonReentrant
    {
        if (block.timestamp > deadline) revert DeadlineExpired();
        _claimEpoch(token, epochId, amount, merkleProof, msg.sender);
        _settle(token, msg.sender, amount, minAssetOut, deadline, false);
    }

    function claimBatchAs(address token, uint256[] calldata epochIds, uint256[] calldata amounts, bytes32[][] calldata merkleProofs, uint256 minAssetOut, uint256 deadline)
        external
        nonReentrant
    {
        if (block.timestamp > deadline) revert DeadlineExpired();
        uint256 total = _claimMany(token, epochIds, amounts, merkleProofs);
        _settle(token, msg.sender, total, minAssetOut, deadline, false);
    }

    function _claimMany(address token, uint256[] calldata epochIds, uint256[] calldata amounts, bytes32[][] calldata merkleProofs)
        internal
        returns (uint256 total)
    {
        if (epochIds.length != amounts.length || epochIds.length != merkleProofs.length) revert ArrayLengthMismatch();
        for (uint256 i = 0; i < epochIds.length; i++) {
            _claimEpoch(token, epochIds[i], amounts[i], merkleProofs[i], msg.sender);
            total += amounts[i];
        }
    }

    /// @dev Effects first: hasClaimed and the per-epoch cap are written BEFORE any external call.
    function _claimEpoch(address token, uint256 epochId, uint256 amount, bytes32[] calldata merkleProof, address claimant) internal {
        bytes32 root = epochMerkleRoots[token][epochId];
        if (root == bytes32(0)) revert EpochNotPublished();
        if (hasClaimed[token][epochId][claimant]) revert AlreadyClaimed();

        bytes32 leaf = keccak256(bytes.concat(keccak256(abi.encode(token, epochId, claimant, amount))));
        if (!MerkleProof.verify(merkleProof, root, leaf)) revert InvalidProof();

        uint256 claimedSoFar = epochClaimedAmounts[token][epochId] + amount;
        if (claimedSoFar > epochAllocatedAmounts[token][epochId]) revert EpochOverClaimed();
        epochClaimedAmounts[token][epochId] = claimedSoFar;
        hasClaimed[token][epochId][claimant] = true;

        emit RewardClaimed(token, epochId, claimant, amount);
    }

    // ================================================================== payout
    /**
     * @dev Decides ETH vs stock and pays. `legacy` marks the V1 signatures.
     *      Order: effects (totalClaimed) -> cheap pre-checks (each failure = ETH fallback, no swap)
     *      -> reference -> swap with amountOutMinimum = max(userMin, protocolFloor) -> on revert,
     *      decide by which bound was binding. No post-swap outcome check can trigger a fallback:
     *      once the adapter returns, stock has already moved.
     */
    function _settle(address token, address claimant, uint256 total, uint256 userMin, uint256 deadline, bool legacy) internal {
        totalClaimed[token] += total;

        TokenAsset memory ta = _tokenAssets[token];
        if (ta.asset == address(0)) {
            _payEth(claimant, total);
            emit RewardPaid(token, claimant, total, address(0), 0);
            return;
        }
        if (ta.forcedEth) {
            _fallback(token, claimant, total, ta.asset, FallbackReason.ForcedEth, "");
            return;
        }
        if (total < minStockRewardWei) {
            _fallback(token, claimant, total, ta.asset, FallbackReason.BelowMinimum, "");
            return;
        }
        // From here the effective payout is the stock: a V1-signature claim cannot carry the
        // user's minAssetOut/deadline, so it must use claimRewardAs / claimBatchAs.
        if (legacy) revert UseClaimAs();

        address asset = ta.asset;
        AssetRoute memory r = _routes[asset];
        if (!r.enabled || r.swapper == address(0)) {
            _fallback(token, claimant, total, asset, FallbackReason.AssetDisabled, "");
            return;
        }
        if (!_isCanonicalStock(asset)) {
            _fallback(token, claimant, total, asset, FallbackReason.RegistryMismatch, "");
            return;
        }
        if (_isPaused(asset)) {
            _fallback(token, claimant, total, asset, FallbackReason.AssetPaused, "");
            return;
        }
        if (_isBlocked(claimant)) {
            _fallback(token, claimant, total, asset, FallbackReason.ClaimantBlocked, "");
            return;
        }
        IRewardSwapper swapper = IRewardSwapper(r.swapper);
        if (swapper.poolLiquidity(r.pool) == 0) {
            _fallback(token, claimant, total, asset, FallbackReason.NoLiquidity, "");
            return;
        }
        (uint256 refOut, bool available) = swapper.referenceOut(r.pool, r.twapWindow, total);
        if (!available) {
            _fallback(token, claimant, total, asset, FallbackReason.ReferenceUnavailable, "");
            return;
        }
        if (refOut == 0) {
            _fallback(token, claimant, total, asset, FallbackReason.NoLiquidity, "");
            return;
        }
        uint256 protocolFloor = refOut * (10_000 - r.maxDeviationBps) / 10_000;
        uint256 amountOutMinimum = userMin > protocolFloor ? userMin : protocolFloor;

        // The ETH goes as msg.value in the SAME call that swaps: a caught revert returns it atomically.
        try swapper.swap{value: total}(asset, r.pool, amountOutMinimum, claimant, deadline) returns (uint256 assetOut) {
            emit RewardPaid(token, claimant, total, asset, assetOut);
        } catch (bytes memory err) {
            if (_selector(err) == IRewardSwapper.InsufficientOutput.selector) {
                if (protocolFloor > userMin) {
                    // the protocol's floor was the binding bound: the protocol's choice -> ETH
                    _fallback(token, claimant, total, asset, FallbackReason.BelowProtocolBound, err);
                } else {
                    // the user's bound was binding: the user's choice -> revert the claim
                    (uint256 amountOut,) = abi.decode(_slice4(err), (uint256, uint256));
                    revert MinOutNotMet(amountOut, userMin);
                }
            } else {
                _fallback(token, claimant, total, asset, FallbackReason.SwapFailed, err);
            }
        }
    }

    function _fallback(address token, address claimant, uint256 total, address asset, FallbackReason reason, bytes memory data) internal {
        _payEth(claimant, total);
        emit RewardPaidInEthFallback(claimant, token, asset, reason, data);
        emit RewardPaid(token, claimant, total, address(0), 0);
    }

    function _payEth(address to, uint256 amount) internal {
        (bool success,) = to.call{value: amount}("");
        if (!success) revert EthTransferFailed();
    }

    // ================================================================== per-token asset
    function setRewardAsset(address token, address asset) external {
        if (!assetSetters[msg.sender]) revert NotAssetSetter();
        if (token == address(0)) revert ZeroAddress();
        if (_tokenAssets[token].assetSet) revert RewardAssetAlreadySet(token);
        if (asset != address(0) && !isSelectableAsset(asset)) revert AssetNotSelectable(asset);
        _tokenAssets[token] = TokenAsset({asset: asset, assetSet: true, forcedEth: false});
        emit RewardAssetSet(token, asset, msg.sender);
    }

    /// @notice One-way: once forced, the token pays ETH forever. For assets that became
    ///         undeliverable (paused, delisted, no liquidity). Cannot move value, only change form.
    function forceEthPayout(address token) external onlyOwner {
        TokenAsset storage ta = _tokenAssets[token];
        if (ta.forcedEth) return;
        ta.forcedEth = true;
        emit EthPayoutForced(token, ta.asset);
    }

    function rewardAsset(address token) external view returns (address asset, bool assetSet, bool forcedEth) {
        TokenAsset memory ta = _tokenAssets[token];
        return (ta.asset, ta.assetSet, ta.forcedEth);
    }

    function effectivePayoutAsset(address token) public view returns (address) {
        TokenAsset memory ta = _tokenAssets[token];
        return ta.forcedEth ? address(0) : ta.asset;
    }

    // ================================================================== allow-list / routes / config
    function setAssetRoute(address asset, AssetRoute calldata route) external onlyOwner {
        if (asset == address(0) || route.swapper == address(0) || route.pool == address(0)) revert ZeroAddress();
        if (route.swapper.code.length == 0) revert InvalidRoute();
        if (route.twapWindow < MIN_TWAP_WINDOW) revert InvalidRoute();
        if (route.maxDeviationBps == 0 || route.maxDeviationBps > MAX_DEVIATION_BPS_CAP) revert InvalidRoute();
        if (!_isCanonicalStock(asset)) revert AssetNotSelectable(asset);
        if (!IRewardSwapper(route.swapper).validateRoute(asset, route.pool, route.fee)) revert InvalidRoute();
        _routes[asset] = route;
        emit AssetRouteSet(asset, route.swapper, route.pool, route.fee, route.twapWindow, route.maxDeviationBps, route.enabled);
    }

    function setAssetEnabled(address asset, bool enabled) external onlyOwner {
        AssetRoute storage r = _routes[asset];
        if (r.swapper == address(0)) revert RouteNotConfigured(asset);
        r.enabled = enabled;
        emit AssetRouteSet(asset, r.swapper, r.pool, r.fee, r.twapWindow, r.maxDeviationBps, enabled);
    }

    function assetRoute(address asset) external view returns (AssetRoute memory) {
        return _routes[asset];
    }

    /// @notice Selectable = enabled route AND registry round-trip AND not paused. The contract
    ///         trusts only the StockFactory round-trip, never a stored list of names.
    function isSelectableAsset(address asset) public view returns (bool) {
        AssetRoute memory r = _routes[asset];
        if (!r.enabled || r.swapper == address(0)) return false;
        if (!_isCanonicalStock(asset)) return false;
        if (_isPaused(asset)) return false;
        return true;
    }

    function setAssetSetter(address setter, bool allowed) external onlyOwner {
        if (setter == address(0)) revert ZeroAddress();
        assetSetters[setter] = allowed;
        emit AssetSetterUpdated(setter, allowed);
    }

    function setMinStockReward(uint256 minStockRewardWei_) external onlyOwner {
        minStockRewardWei = minStockRewardWei_;
        emit MinStockRewardUpdated(minStockRewardWei_);
    }

    // ================================================================== accounting views
    function tokenVault(address token) external view returns (uint256) {
        return totalDeposited[token] - totalClaimed[token];
    }

    // ================================================================== admin (V1)
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

    // ================================================================== registry helpers
    /// @dev `uid()` on an arbitrary contract may revert or return garbage; the factory mapping is
    ///      the authority. A counterfeit returning AAPL's uid maps to AAPL's address, not its own.
    function _isCanonicalStock(address asset) internal view returns (bool) {
        if (asset.code.length == 0) return false;
        (bool ok, bytes memory ret) = asset.staticcall(abi.encodeCall(IRobinhoodStock.uid, ()));
        if (!ok || ret.length != 32) return false;
        bytes32 uid = abi.decode(ret, (bytes32));
        return stockFactory.tokenAddress(uid) == asset;
    }

    function _isPaused(address asset) internal view returns (bool) {
        (bool ok, bytes memory ret) = asset.staticcall(abi.encodeCall(IRobinhoodStock.paused, ()));
        if (!ok || ret.length != 32) return true; // unreadable = treat as undeliverable
        return abi.decode(ret, (bool));
    }

    function _isBlocked(address account) internal view returns (bool) {
        (bool ok, bytes memory ret) = address(accessRegistry).staticcall(abi.encodeCall(IRobinhoodAccessControlsRegistry.isBlocked, (account)));
        if (!ok || ret.length != 32) return true;
        return abi.decode(ret, (bool));
    }

    function _selector(bytes memory err) internal pure returns (bytes4 sel) {
        if (err.length < 4) return bytes4(0);
        assembly ("memory-safe") {
            sel := mload(add(err, 32))
        }
    }

    function _slice4(bytes memory err) internal pure returns (bytes memory out) {
        out = new bytes(err.length - 4);
        for (uint256 i = 0; i < out.length; i++) {
            out[i] = err[i + 4];
        }
    }
}
