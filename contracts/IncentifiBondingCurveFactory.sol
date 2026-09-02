// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "./IncentifiBondingCurve.sol";

interface IIncentifiToken {
    function creator() external view returns (address);
    function totalSupply() external view returns (uint256);
}

/**
 * @title IncentifiBondingCurveFactory
 * @notice Factory for deploying and tracking Incentifi bonding curve instances.
 *         Supports both new token onboarding and existing-token migration with strict authentication.
 */
contract IncentifiBondingCurveFactory {
    using SafeTransferLib for address;

    address public immutable lossRewardPool;
    address public immutable weth;
    address public immutable positionManager;
    address public immutable uniswapFactory;

    // Token => Bonding Curve
    mapping(address => address) public getBondingCurve;
    // Bonding Curve => bool
    mapping(address => bool) public isBondingCurve;
    // List of all deployed bonding curves
    address[] public allCurves;

    event BondingCurveCreated(
        address indexed token,
        address indexed curve,
        address indexed creator,
        uint256 initialInventory
    );

    error ZeroAddress();
    error AlreadyRegistered();
    error NotTokenCreator();
    error InvalidTotalSupply();
    error DeploymentFailed();

    constructor(
        address _lossRewardPool,
        address _weth,
        address _positionManager,
        address _uniswapFactory
    ) {
        if (
            _lossRewardPool == address(0) ||
            _weth == address(0) ||
            _positionManager == address(0) ||
            _uniswapFactory == address(0)
        ) {
            revert ZeroAddress();
        }

        lossRewardPool = _lossRewardPool;
        weth = _weth;
        positionManager = _positionManager;
        uniswapFactory = _uniswapFactory;
    }

    /**
     * @notice Returns total number of deployed bonding curves.
     */
    function allCurvesLength() external view returns (uint256) {
        return allCurves.length;
    }

    /**
     * @notice Checks if a token has graduated from its bonding curve.
     */
    function isGraduated(address token) external view returns (bool) {
        address curve = getBondingCurve[token];
        if (curve == address(0)) return false;
        return IncentifiBondingCurve(payable(curve)).graduated();
    }

    /**
     * @notice Registers and migrates an existing 1B-supply token into a new bonding curve.
     *         Requires the token creator to approve this factory (or curve) for the full 1B supply.
     * @param token Address of the existing token (e.g. 0xb617bf8807db8763a2f86a5d15bab2ba83cfff10).
     * @param creator Address of the token creator (must match msg.sender and token.creator()).
     */
    function registerExistingToken(
        address token,
        address creator
    ) external returns (address curve) {
        if (token == address(0) || creator == address(0)) revert ZeroAddress();
        if (getBondingCurve[token] != address(0)) revert AlreadyRegistered();

        // Strict creator verification
        if (msg.sender != creator) revert NotTokenCreator();
        try IIncentifiToken(token).creator() returns (address tokenCreator) {
            if (tokenCreator != creator) revert NotTokenCreator();
        } catch {
            // Token must implement creator()
            revert NotTokenCreator();
        }

        // Verify total supply is exactly 1 Billion tokens
        uint256 supply = IERC20(token).totalSupply();
        if (supply != 1_000_000_000 * 1e18) revert InvalidTotalSupply();

        // Deploy new bonding curve
        IncentifiBondingCurve newCurve = new IncentifiBondingCurve(
            token,
            creator,
            lossRewardPool,
            weth,
            positionManager,
            uniswapFactory
        );

        curve = address(newCurve);

        // Custody 1B tokens into the new bonding curve
        token.safeTransferFrom(creator, curve, supply);

        // Initialize curve
        newCurve.initialize();

        // Register in state
        getBondingCurve[token] = curve;
        isBondingCurve[curve] = true;
        allCurves.push(curve);

        emit BondingCurveCreated(token, curve, creator, supply);
    }
}
