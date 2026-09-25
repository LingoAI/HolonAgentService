// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/token/ERC721/IERC721.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/// @notice ERC-8183 minimal, fixed-token escrow. No hooks, fees or admin withdrawals.
/// @dev Lifecycle follows https://eips.ethereum.org/EIPS/eip-8183 (2026-09-15).
contract TaskEscrow is ReentrancyGuard {
    using SafeERC20 for IERC20;
    enum Status { Open, Funded, Submitted, Completed, Rejected, Expired }
    struct Job {
        address client;
        address provider;
        address evaluator;
        uint256 budget;
        uint256 expiredAt;
        Status status;
        string description;
        bytes32 deliverable;
        uint256 agentId;
        bool hasAgent;
    }
    IERC20 public immutable paymentToken;
    IERC721 public immutable identityRegistry;
    uint256 public jobCount;
    mapping(uint256 => Job) private _jobs;
    event JobCreated(uint256 indexed jobId, address indexed client, address indexed provider, address evaluator, uint256 expiredAt, string description);
    event ProviderSet(uint256 indexed jobId, address indexed provider);
    event AgentLinked(uint256 indexed jobId, uint256 indexed agentId, address indexed provider);
    event BudgetSet(uint256 indexed jobId, uint256 amount);
    event JobFunded(uint256 indexed jobId, address indexed client, uint256 amount);
    event JobSubmitted(uint256 indexed jobId, address indexed provider, bytes32 deliverable);
    event DeliveryURI(uint256 indexed jobId, bytes32 indexed deliverable, string uri);
    event JobCompleted(uint256 indexed jobId, address indexed evaluator, bytes32 reason);
    event JobRejected(uint256 indexed jobId, address indexed rejector, bytes32 reason);
    event JobExpired(uint256 indexed jobId);
    event PaymentReleased(uint256 indexed jobId, address indexed provider, uint256 amount);
    event Refunded(uint256 indexed jobId, address indexed client, uint256 amount);

    constructor(address token, address registry) {
        require(token.code.length > 0 && registry.code.length > 0, "invalid contracts");
        paymentToken = IERC20(token);
        identityRegistry = IERC721(registry);
    }
    function getJob(uint256 id) public view returns (Job memory) {
        require(id > 0 && id <= jobCount, "unknown job");
        return _jobs[id];
    }
    function createJob(address provider, address evaluator, uint256 expiredAt, string calldata description) external returns (uint256) {
        return _create(provider, evaluator, expiredAt, description);
    }
    function createAgentJob(uint256 agentId, address evaluator, uint256 expiredAt, string calldata description) external returns (uint256 id) {
        address provider = identityRegistry.ownerOf(agentId);
        id = _create(provider, evaluator, expiredAt, description);
        _link(id, agentId, provider);
    }
    function _create(address provider, address evaluator, uint256 expiry, string memory description) internal returns (uint256 id) {
        require(evaluator != address(0), "evaluator required");
        require(expiry > block.timestamp, "invalid expiry");
        require(bytes(description).length > 0 && bytes(description).length <= 4096, "invalid description");
        id = ++jobCount;
        Job storage job = _jobs[id];
        job.client = msg.sender;
        job.provider = provider;
        job.evaluator = evaluator;
        job.expiredAt = expiry;
        job.description = description;
        emit JobCreated(id, msg.sender, provider, evaluator, expiry, description);
    }
    function setProvider(uint256 id, address provider) external {
        _assign(id, provider);
    }
    function setAgentProvider(uint256 id, uint256 agentId) external {
        address provider = identityRegistry.ownerOf(agentId);
        _assign(id, provider);
        _link(id, agentId, provider);
    }
    function _assign(uint256 id, address provider) internal {
        Job storage j = _open(id);
        require(msg.sender == j.client, "client only");
        require(j.provider == address(0) && provider != address(0), "provider already set or zero");
        j.provider = provider;
        emit ProviderSet(id, provider);
    }
    function _link(uint256 id, uint256 agentId, address provider) internal {
        _jobs[id].agentId = agentId;
        _jobs[id].hasAgent = true;
        emit AgentLinked(id, agentId, provider);
    }
    function _open(uint256 id) internal view returns (Job storage j) {
        require(id > 0 && id <= jobCount, "unknown job");
        j = _jobs[id];
        require(j.status == Status.Open, "not open");
        require(block.timestamp < j.expiredAt, "expired");
    }
    function setBudget(uint256 id, uint256 amount) external {
        Job storage j = _open(id);
        require(msg.sender == j.client || msg.sender == j.provider, "client or provider only");
        j.budget = amount;
        emit BudgetSet(id, amount);
    }
    function fund(uint256 id, uint256 expectedBudget) external nonReentrant {
        Job storage j = _open(id);
        require(msg.sender == j.client, "client only");
        require(j.provider != address(0), "provider required");
        require(j.budget > 0 && j.budget == expectedBudget, "budget mismatch");
        j.status = Status.Funded;
        uint256 beforeBalance = paymentToken.balanceOf(address(this));
        paymentToken.safeTransferFrom(msg.sender, address(this), j.budget);
        require(paymentToken.balanceOf(address(this)) - beforeBalance == j.budget, "unsupported token transfer");
        emit JobFunded(id, msg.sender, j.budget);
    }
    function submit(uint256 id, bytes32 deliverable) external {
        _submit(id, deliverable);
    }
    /// @notice Submit a public IPFS manifest while preserving the original
    /// ERC-8183 submission event for existing indexers.
    /// @dev The contract checks only a bounded lowercase CIDv1/base32 URI.
    /// Clients remain responsible for fetching and validating its contents.
    function submitWithURI(uint256 id, bytes32 deliverable, string calldata uri) external {
        require(deliverable != bytes32(0), "deliverable required");
        bytes memory value = bytes(uri);
        require(value.length >= 8 && value.length <= 200, "invalid uri length");
        bytes memory prefix = bytes("ipfs://b");
        for (uint256 i = 0; i < prefix.length; i++) require(value[i] == prefix[i], "invalid uri scheme");
        for (uint256 i = prefix.length; i < value.length; i++) {
            bytes1 c = value[i];
            require((c >= 0x61 && c <= 0x7a) || (c >= 0x32 && c <= 0x37), "invalid cid character");
        }
        _submit(id, deliverable);
        emit DeliveryURI(id, deliverable, uri);
    }
    function _submit(uint256 id, bytes32 deliverable) internal {
        getJob(id);
        Job storage j = _jobs[id];
        require(j.status == Status.Funded, "not funded");
        require(block.timestamp < j.expiredAt, "expired");
        require(msg.sender == j.provider, "provider only");
        j.deliverable = deliverable;
        j.status = Status.Submitted;
        emit JobSubmitted(id, msg.sender, deliverable);
    }
    function complete(uint256 id, bytes32 reason) external nonReentrant {
        getJob(id);
        Job storage j = _jobs[id];
        require(j.status == Status.Submitted, "not submitted");
        require(block.timestamp < j.expiredAt, "expired");
        require(msg.sender == j.evaluator, "evaluator only");
        j.status = Status.Completed;
        paymentToken.safeTransfer(j.provider, j.budget);
        emit PaymentReleased(id, j.provider, j.budget);
        emit JobCompleted(id, msg.sender, reason);
    }
    function reject(uint256 id, bytes32 reason) external nonReentrant {
        getJob(id);
        Job storage j = _jobs[id];
        bool funded = j.status == Status.Funded || j.status == Status.Submitted;
        require(j.status == Status.Open || funded, "terminal job");
        require(msg.sender == (funded ? j.evaluator : j.client), "unauthorized reject");
        j.status = Status.Rejected;
        if (funded) {
            paymentToken.safeTransfer(j.client, j.budget);
            emit Refunded(id, j.client, j.budget);
        }
        emit JobRejected(id, msg.sender, reason);
    }
    function claimRefund(uint256 id) external nonReentrant {
        getJob(id);
        Job storage j = _jobs[id];
        require(j.status == Status.Funded || j.status == Status.Submitted, "not escrowed");
        require(block.timestamp >= j.expiredAt, "not expired");
        j.status = Status.Expired;
        paymentToken.safeTransfer(j.client, j.budget);
        emit Refunded(id, j.client, j.budget);
        emit JobExpired(id);
    }
}
