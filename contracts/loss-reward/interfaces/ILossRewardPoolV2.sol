// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

/**
 * @title ILossRewardPoolV2
 * @notice V1 surface preserved verbatim (same names, semantics, leaf format, operator model) plus
 *         a creator-selected payout asset with an ETH fallback. See docs/LOSS_REWARD_ASSET_DESIGN.md.
 */
interface ILossRewardPoolV2 {
    // ------------------------------------------------------------------ types
    struct AssetRoute {
        address swapper;        // IRewardSwapper
        address pool;           // canonical Uniswap V3 WETH/asset pool
        uint24 fee;             // pool fee tier
        uint32 twapWindow;      // seconds, protocol reference
        uint16 maxDeviationBps; // executed output must be >= TWAP-implied * (1 - this)
        bool enabled;
    }

    enum FallbackReason {
        ForcedEth,            // owner forced this token to ETH
        AssetDisabled,        // no enabled route for the asset
        RegistryMismatch,     // uid()/tokenAddress() round-trip failed at claim time
        AssetPaused,          // asset.paused() (token or global)
        ClaimantBlocked,      // registry.isBlocked(claimant): a transfer to them would revert
        NoLiquidity,          // EMPTY pool: zero in-range liquidity, or a zero reference. Thin (but nonzero)
                              // liquidity is not caught here; it surfaces in-swap as BelowProtocolBound.
        ReferenceUnavailable, // TWAP could not be read
        BelowMinimum,         // batch total below minStockRewardWei
        BelowProtocolBound,   // swap reverted InsufficientOutput and the protocol floor was binding
        SwapFailed            // any other revert from the adapter / pool / token
    }

    // ------------------------------------------------------------------ V1 events
    event RewardDeposited(address indexed token, address indexed sender, uint256 amount);
    event EpochRootPublished(address indexed token, uint256 indexed epochId, bytes32 merkleRoot, uint256 allocatedAmount);
    event RewardClaimed(address indexed token, uint256 indexed epochId, address indexed claimant, uint256 amount);
    event OperatorUpdated(address indexed previousOperator, address indexed newOperator);
    event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);

    // ------------------------------------------------------------------ V2 events
    event RewardAssetSet(address indexed token, address indexed asset, address indexed setter);
    event EthPayoutForced(address indexed token, address indexed previousAsset);
    event AssetRouteSet(address indexed asset, address swapper, address pool, uint24 fee, uint32 twapWindow, uint16 maxDeviationBps, bool enabled);
    event AssetSetterUpdated(address indexed setter, bool allowed);
    event MinStockRewardUpdated(uint256 minStockRewardWei);
    /// @dev asset == address(0) and assetAmount == 0 for an ETH payout (including every fallback).
    event RewardPaid(address indexed token, address indexed claimant, uint256 ethAmount, address indexed asset, uint256 assetAmount);
    event RewardPaidInEthFallback(address indexed claimant, address indexed token, address indexed asset, FallbackReason reason, bytes data);

    // ------------------------------------------------------------------ V1 errors
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

    // ------------------------------------------------------------------ V2 errors
    /// @dev V1-signature claim on a token whose effective payout is a stock: use claimRewardAs / claimBatchAs.
    error UseClaimAs();
    error DeadlineExpired();
    /// @dev The user's own minAssetOut was the binding bound and was not met; the claim reverts.
    error MinOutNotMet(uint256 amountOut, uint256 minAssetOut);
    error AssetNotSelectable(address asset);
    error RewardAssetAlreadySet(address token);
    error NotAssetSetter();
    error EpochOverClaimed();
    error BareEthRejected();
    error InvalidRoute();
    error RouteNotConfigured(address asset);

    // ------------------------------------------------------------------ V1 functions (unchanged)
    function depositReward(address token) external payable;
    function getUnallocatedBalance(address token) external view returns (uint256);
    function setEpochMerkleRoot(address token, uint256 epochId, bytes32 merkleRoot, uint256 allocatedAmount) external;
    function claimReward(address token, uint256 epochId, uint256 amount, bytes32[] calldata merkleProof) external;
    function claimBatch(address token, uint256[] calldata epochIds, uint256[] calldata amounts, bytes32[][] calldata merkleProofs) external;
    function totalDeposited(address token) external view returns (uint256);
    function totalAllocated(address token) external view returns (uint256);
    function totalClaimed(address token) external view returns (uint256);
    function epochMerkleRoots(address token, uint256 epochId) external view returns (bytes32);
    function epochAllocatedAmounts(address token, uint256 epochId) external view returns (uint256);
    function hasClaimed(address token, uint256 epochId, address account) external view returns (bool);
    function owner() external view returns (address);
    function operator() external view returns (address);
    function setOperator(address newOperator) external;
    function transferOwnership(address newOwner) external;

    // ------------------------------------------------------------------ V2: claims that may pay in stock
    /// @notice Works for ETH tokens too (minAssetOut is ignored; deadline is still enforced).
    ///         minStockRewardWei applies to the BATCH TOTAL, so small epochs can be combined.
    function claimRewardAs(address token, uint256 epochId, uint256 amount, bytes32[] calldata merkleProof, uint256 minAssetOut, uint256 deadline) external;
    function claimBatchAs(address token, uint256[] calldata epochIds, uint256[] calldata amounts, bytes32[][] calldata merkleProofs, uint256 minAssetOut, uint256 deadline) external;

    // ------------------------------------------------------------------ V2: per-token asset
    function setRewardAsset(address token, address asset) external;
    function forceEthPayout(address token) external;
    function rewardAsset(address token) external view returns (address asset, bool assetSet, bool forcedEth);
    function effectivePayoutAsset(address token) external view returns (address);

    // ------------------------------------------------------------------ V2: allow-list / routes / config
    function setAssetRoute(address asset, AssetRoute calldata route) external;
    function setAssetEnabled(address asset, bool enabled) external;
    function assetRoute(address asset) external view returns (AssetRoute memory);
    function isSelectableAsset(address asset) external view returns (bool);
    function setAssetSetter(address setter, bool allowed) external;
    function assetSetters(address setter) external view returns (bool);
    function setMinStockReward(uint256 minStockRewardWei_) external;
    function minStockRewardWei() external view returns (uint256);

    // ------------------------------------------------------------------ V2: strict accounting
    function epochClaimedAmounts(address token, uint256 epochId) external view returns (uint256);
    function tokenVault(address token) external view returns (uint256);
}
