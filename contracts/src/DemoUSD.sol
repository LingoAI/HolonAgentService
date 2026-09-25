// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;
import "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";

/// @notice Test-only ERC-20 with EIP-3009 authorization. Not USDC, no monetary value.
contract DemoUSD is ERC20, EIP712 {
    mapping(address => mapping(bytes32 => bool)) public authorizationState;
    event AuthorizationUsed(address indexed authorizer, bytes32 indexed nonce);
    bytes32 private constant TRANSFER_TYPEHASH = keccak256("TransferWithAuthorization(address from,address to,uint256 value,uint256 validAfter,uint256 validBefore,bytes32 nonce)");
    bytes32 private constant RECEIVE_TYPEHASH = keccak256("ReceiveWithAuthorization(address from,address to,uint256 value,uint256 validAfter,uint256 validBefore,bytes32 nonce)");
    constructor(address holder) ERC20("Demo USD", "dUSD") EIP712("Demo USD", "1") {
        require(block.chainid == 31337 || block.chainid == 1952, "test networks only");
        _mint(holder, 1_000_000 * 10 ** 6);
    }
    function decimals() public pure override returns (uint8) { return 6; }
    function transferWithAuthorization(address from, address to, uint256 value, uint256 validAfter, uint256 validBefore, bytes32 nonce, uint8 v, bytes32 r, bytes32 s) external {
        _authorized(TRANSFER_TYPEHASH, from, to, value, validAfter, validBefore, nonce, v, r, s);
    }
    function receiveWithAuthorization(address from, address to, uint256 value, uint256 validAfter, uint256 validBefore, bytes32 nonce, uint8 v, bytes32 r, bytes32 s) external {
        require(msg.sender == to, "payee only");
        _authorized(RECEIVE_TYPEHASH, from, to, value, validAfter, validBefore, nonce, v, r, s);
    }
    function _authorized(bytes32 typeHash, address from, address to, uint256 value, uint256 validAfter, uint256 validBefore, bytes32 nonce, uint8 v, bytes32 r, bytes32 s) internal {
        require(block.timestamp > validAfter && block.timestamp < validBefore, "authorization time");
        require(!authorizationState[from][nonce], "authorization used");
        bytes32 digest = _hashTypedDataV4(keccak256(abi.encode(typeHash, from, to, value, validAfter, validBefore, nonce)));
        require(ECDSA.recover(digest, v, r, s) == from, "invalid signature");
        authorizationState[from][nonce] = true;
        emit AuthorizationUsed(from, nonce);
        _transfer(from, to, value);
    }
}
