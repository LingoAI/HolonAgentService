// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/token/ERC721/IERC721.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/// @notice Deliberately capped X Layer mainnet canary for the fixed-bounty flow.
/// @dev This is a demonstration escrow, not the planned production market contract.
///      The immutable caps limit each job and the aggregate amount held by this
///      deployment even when callers bypass the web application.
contract MainnetCanaryEscrow is ReentrancyGuard {
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
    uint256 public immutable maxBudget;
    uint256 public immutable maxTotalEscrowed;
    uint256 public totalEscrowed;
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

    constructor(address token, address registry, uint256 budgetLimit, uint256 aggregateLimit) {
        require(token.code.length > 0 && registry.code.length > 0, "invalid contracts");
        require(budgetLimit > 0 && aggregateLimit >= budgetLimit, "invalid canary limits");
        paymentToken = IERC20(token);
        identityRegistry = IERC721(registry);
        maxBudget = budgetLimit;
        maxTotalEscrowed = aggregateLimit;
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
        Job storage job = _open(id);
        require(msg.sender == job.client, "client only");
        require(job.provider == address(0) && provider != address(0), "provider already set or zero");
        job.provider = provider;
        emit ProviderSet(id, provider);
    }

    function _link(uint256 id, uint256 agentId, address provider) internal {
        _jobs[id].agentId = agentId;
        _jobs[id].hasAgent = true;
        emit AgentLinked(id, agentId, provider);
    }

    function _open(uint256 id) internal view returns (Job storage job) {
        require(id > 0 && id <= jobCount, "unknown job");
        job = _jobs[id];
        require(job.status == Status.Open, "not open");
        require(block.timestamp < job.expiredAt, "expired");
    }

    function setBudget(uint256 id, uint256 amount) external {
        Job storage job = _open(id);
        require(msg.sender == job.client || msg.sender == job.provider, "client or provider only");
        require(amount > 0 && amount <= maxBudget, "canary budget limit");
        job.budget = amount;
        emit BudgetSet(id, amount);
    }

    function fund(uint256 id, uint256 expectedBudget) external nonReentrant {
        Job storage job = _open(id);
        require(msg.sender == job.client, "client only");
        require(job.provider != address(0), "provider required");
        require(job.budget > 0 && job.budget == expectedBudget, "budget mismatch");
        require(job.budget <= maxBudget, "canary budget limit");
        require(totalEscrowed + job.budget <= maxTotalEscrowed, "canary aggregate limit");
        job.status = Status.Funded;
        totalEscrowed += job.budget;
        uint256 beforeBalance = paymentToken.balanceOf(address(this));
        paymentToken.safeTransferFrom(msg.sender, address(this), job.budget);
        require(paymentToken.balanceOf(address(this)) - beforeBalance == job.budget, "unsupported token transfer");
        emit JobFunded(id, msg.sender, job.budget);
    }

    function submit(uint256 id, bytes32 deliverable) external {
        _submit(id, deliverable);
    }

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
        Job storage job = _jobs[id];
        require(job.status == Status.Funded, "not funded");
        require(block.timestamp < job.expiredAt, "expired");
        require(msg.sender == job.provider, "provider only");
        job.deliverable = deliverable;
        job.status = Status.Submitted;
        emit JobSubmitted(id, msg.sender, deliverable);
    }

    function complete(uint256 id, bytes32 reason) external nonReentrant {
        getJob(id);
        Job storage job = _jobs[id];
        require(job.status == Status.Submitted, "not submitted");
        require(block.timestamp < job.expiredAt, "expired");
        require(msg.sender == job.evaluator, "evaluator only");
        job.status = Status.Completed;
        totalEscrowed -= job.budget;
        paymentToken.safeTransfer(job.provider, job.budget);
        emit PaymentReleased(id, job.provider, job.budget);
        emit JobCompleted(id, msg.sender, reason);
    }

    function reject(uint256 id, bytes32 reason) external nonReentrant {
        getJob(id);
        Job storage job = _jobs[id];
        bool funded = job.status == Status.Funded || job.status == Status.Submitted;
        require(job.status == Status.Open || funded, "terminal job");
        require(msg.sender == (funded ? job.evaluator : job.client), "unauthorized reject");
        job.status = Status.Rejected;
        if (funded) {
            totalEscrowed -= job.budget;
            paymentToken.safeTransfer(job.client, job.budget);
            emit Refunded(id, job.client, job.budget);
        }
        emit JobRejected(id, msg.sender, reason);
    }

    function claimRefund(uint256 id) external nonReentrant {
        getJob(id);
        Job storage job = _jobs[id];
        require(job.status == Status.Funded || job.status == Status.Submitted, "not escrowed");
        require(block.timestamp >= job.expiredAt, "not expired");
        job.status = Status.Expired;
        totalEscrowed -= job.budget;
        paymentToken.safeTransfer(job.client, job.budget);
        emit Refunded(id, job.client, job.budget);
        emit JobExpired(id);
    }
}
