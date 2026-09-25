# HolonAgentService by LingoAI · OKX AI + X Layer

## Competition submission

**Project Name:** HolonAgentService by LingoAI

**Project Summary:** HolonAgentService makes AI agent services verifiable from purchase to delivery. It connects wallet-owned agent identity, fixed task terms, capped native USDC escrow on X Layer, IPFS delivery proofs, and onchain acceptance and settlement. A completed 0.10 USDC mainnet order provides public transaction and delivery evidence.

OKX Dev Day 2026 **Build a Company** 项目。平台将 Agent 身份、明确的任务条款、资金托管、内容交付和验收结算串成可核验的服务流程。OKX AI ASP 身份和 A2A 服务已注册。

## X Layer 主网部署

[打开线上市场](https://holonagentservice.lingoai.io/#marketplace)。当前公开演示使用 Circle 原生 USDC 和固定额度的主网托管合约：

| 项目 | 主网数据 |
| --- | --- |
| 网络 | X Layer Mainnet，chain ID `196` |
| 原生 USDC | `0xB6CEceAB302E2E4948951eE7843FC24E92933061` |
| ERC-8004 Identity Registry | `0xc29d13d375195E60EAf565eab154d68c5084773f` |
| MainnetCanaryEscrow | `0xCDF4fF99a28b231A0446A8be1c36B4A5E3D50215` |
| 合约额度上限 | 单笔 `1 USDC`，同时托管总额 `5 USDC` |

2026-09-22，Agent ID `0` / Job ID `1` 完成一笔 `0.10 USDC` 订单，从托管付款、IPFS 交付到链上验收结算均有公开记录：

- [结算交易](https://www.okx.com/web3/explorer/xlayer/tx/0x1761a092116069e3e0e8e9352f3eba439b249e9b5e14898f4c196abeb0cd6b93)
- [IPFS 交付清单](https://gateway.pinata.cloud/ipfs/bafkreiaz5zjkghkloum6gc3vwe6duni7ay4upw4iax6fmw4t7mpcjuwnly)
- [完整主网证明数据](evidence/xlayer/mainnet-native-usdc-proof-2026-09-22.json)
- [线上只读证明接口](https://holonagentservice.lingoai.io/api/xlayer/mainnet-proof)

这笔订单由团队控制的演示钱包完成。主网合约有不可变额度上限，用于公开演示。

## 用户流程

1. 买方连接钱包并通过 SIWE 登录，发布固定任务，锁定赏金、验收者和截止时间。
2. 服务商用自己的钱包注册 ERC-8004 Agent 身份，签署绑定任务条款的 EIP-712 申请。
3. 买方选择服务商，用浏览器钱包创建订单、授权精确 USDC 金额并注资。交易意图和广播哈希可在中断后恢复。
4. 服务商交付公开内容；服务端将原始字节和清单固定到 IPFS、回读核对，并导出 CAR 备份。
5. 指定验收者在截止前确认付款或拒绝退款；逾期订单可按合约规则退款。

网页提供任务、服务商、申请、订单和交付证据工作区。所有用户资金操作由连接的浏览器钱包签名。

## 实现与验证

- `contracts/src/MainnetCanaryEscrow.sol`：主网演示托管和固定额度限制。
- `backend/marketplace/mvp.py`：任务、申请、订单、交付与恢复 API。
- `backend/marketplace/mvp_storage.py`：IPFS pin、精确字节回读和 CAR 导出。
- `backend/marketplace/mainnet_proof.py`：主网订单的只读公开证明。
- `protocol/chain.mjs`：链上交易构造、事件读取与证明缓存。

本地开发需要 Node.js 22、Python 3.12、npm 和 uv。完整交付流程还需要可访问的 Kubo API。

```bash
./scripts/setup-local.sh
npm run dev:local
```

另开终端运行验证：

```bash
npm run test:contracts
npm run test:protocol
.venv/bin/python -m pytest backend/tests -q
npm run build:wallet
```

已执行的结果：合约测试 10 项、协议测试 32 项、后端测试 281 项通过、1 项因未配置云端密钥跳过。主网交易证明与自动测试分别提供链上结果和代码行为的核验依据。

## License

MIT License

Copyright (c) 2026 samitha278

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
