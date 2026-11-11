"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || function (mod) {
    if (mod && mod.__esModule) return mod;
    var result = {};
    if (mod != null) for (var k in mod) if (k !== "default" && Object.prototype.hasOwnProperty.call(mod, k)) __createBinding(result, mod, k);
    __setModuleDefault(result, mod);
    return result;
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.ZetoNonFungibleInstance = exports.ZetoInstance = exports.ZetoFactory = exports.ZetoNonFungibleFuture = exports.ZetoFuture = exports.zetoConstructorABI_V1 = exports.zetoConstructorABI = exports.IDEN3_PUBKEY_BABYJUBJUB_COMPRESSED_0X = exports.algorithmZetoSnarkBJJ = void 0;
const interfaces_1 = require("../interfaces");
const transaction_1 = require("../transaction");
const zetoPrivateJSON = __importStar(require("./abis/IZetoFungible.json"));
const zetoNonFungiblePrivateJSON = __importStar(require("./abis/IZetoNonFungible.json"));
const zetoPrivateV1JSON = __importStar(require("./abis/IZetoFungible_V1.json"));
const zetoPublicJSON = __importStar(require("./abis/Zeto_Anon.json"));
// Algorithm/verifier types specific to Zeto
const algorithmZetoSnarkBJJ = (domainName) => `domain:${domainName}:snark:babyjubjub`;
exports.algorithmZetoSnarkBJJ = algorithmZetoSnarkBJJ;
exports.IDEN3_PUBKEY_BABYJUBJUB_COMPRESSED_0X = "iden3_pubkey_babyjubjub_compressed_0x";
const zetoAbi = zetoPrivateJSON.abi;
const zetoNonFungibleAbi = zetoNonFungiblePrivateJSON.abi;
// The V1 transaction API: createLock / spendLock / cancelLock in place of V0's lock / transferLocked.
const zetoAbiV1 = zetoPrivateV1JSON.abi;
const zetoPublicAbi = zetoPublicJSON.abi;
exports.zetoConstructorABI = {
    type: "constructor",
    inputs: [{ name: "tokenName", type: "string" }],
};
// Opts a pool into the V1 transaction axis. The generation decides the on-chain calldata shape — zeto-contracts
// ~v0.5.x takes a single packed `bytes proof` where ~v0.2.x took a discrete proof tuple — so a pool deployed without
// these against v0.5.x implementations reverts on the first proving call (deposit) with no decodable revert data.
exports.zetoConstructorABI_V1 = {
    type: "constructor",
    inputs: [
        { name: "tokenName", type: "string" },
        { name: "domainConfigSchema", type: "string" },
        { name: "zetoVariant", type: "uint256" },
        { name: "factoryVersion", type: "uint256" },
    ],
};
// Represents an in-flight Zeto deployment
class ZetoFuture extends transaction_1.TransactionFuture {
    async waitForDeploy(waitMs) {
        const receipt = await this.waitForReceipt(waitMs);
        return receipt?.contractAddress
            ? new ZetoInstance(this.paladin, receipt.contractAddress)
            : undefined;
    }
}
exports.ZetoFuture = ZetoFuture;
class ZetoNonFungibleFuture extends transaction_1.TransactionFuture {
    async waitForDeploy(waitMs) {
        const receipt = await this.waitForReceipt(waitMs);
        return receipt?.contractAddress
            ? new ZetoNonFungibleInstance(this.paladin, receipt.contractAddress)
            : undefined;
    }
}
exports.ZetoNonFungibleFuture = ZetoNonFungibleFuture;
class ZetoFactory {
    constructor(paladin, domain) {
        this.paladin = paladin;
        this.domain = domain;
    }
    using(paladin) {
        return new ZetoFactory(paladin, this.domain);
    }
    newZeto(from, data) {
        // The V1 constructor carries three extra params, so the ABI has to match what is actually being sent.
        const abi = data.domainConfigSchema !== undefined ||
            data.zetoVariant !== undefined ||
            data.factoryVersion !== undefined
            ? exports.zetoConstructorABI_V1
            : exports.zetoConstructorABI;
        return new ZetoFuture(this.paladin, this.paladin.sendTransaction({
            type: interfaces_1.TransactionType.PRIVATE,
            domain: this.domain,
            abi: [abi],
            function: "",
            from: from.lookup,
            data,
        }));
    }
    newZetoNonFungible(from, data) {
        return new ZetoNonFungibleFuture(this.paladin, this.paladin.sendTransaction({
            type: interfaces_1.TransactionType.PRIVATE,
            domain: this.domain,
            abi: [exports.zetoConstructorABI],
            function: "",
            from: from.lookup,
            data,
        }));
    }
}
exports.ZetoFactory = ZetoFactory;
class ZetoInstance {
    constructor(paladin, address) {
        this.paladin = paladin;
        this.address = address;
    }
    using(paladin) {
        const zeto = new ZetoInstance(paladin, this.address);
        zeto.erc20 = this.erc20;
        return zeto;
    }
    mint(from, data) {
        const params = {
            mints: data.mints.map((t) => ({ ...t, to: t.to.lookup })),
        };
        return new transaction_1.TransactionFuture(this.paladin, this.paladin.sendTransaction({
            type: interfaces_1.TransactionType.PRIVATE,
            abi: zetoAbi,
            function: "mint",
            to: this.address,
            from: from.lookup,
            data: params,
        }));
    }
    transfer(from, data) {
        return new transaction_1.TransactionFuture(this.paladin, this.paladin.sendTransaction({
            type: interfaces_1.TransactionType.PRIVATE,
            abi: zetoAbi,
            function: "transfer",
            to: this.address,
            from: from.lookup,
            data: {
                transfers: data.transfers.map((t) => ({ ...t, to: t.to.lookup })),
            },
        }));
    }
    transferLocked(from, data) {
        return new transaction_1.TransactionFuture(this.paladin, this.paladin.sendTransaction({
            type: interfaces_1.TransactionType.PRIVATE,
            abi: zetoAbi,
            function: "transferLocked",
            to: this.address,
            from: from.lookup,
            data: {
                lockedInputs: data.lockedInputs,
                delegate: data.delegate,
                transfers: data.transfers.map((t) => ({ ...t, to: t.to.lookup })),
            },
        }));
    }
    prepareTransferLocked(from, data) {
        return new transaction_1.TransactionFuture(this.paladin, this.paladin.prepareTransaction({
            type: interfaces_1.TransactionType.PRIVATE,
            abi: zetoAbi,
            function: "transferLocked",
            to: this.address,
            from: from.lookup,
            data: {
                lockedInputs: data.lockedInputs,
                delegate: data.delegate,
                transfers: data.transfers.map((t) => ({ ...t, to: t.to.lookup })),
            },
        }));
    }
    lock(from, data) {
        return new transaction_1.TransactionFuture(this.paladin, this.paladin.sendTransaction({
            type: interfaces_1.TransactionType.PRIVATE,
            abi: zetoAbi,
            function: "lock",
            to: this.address,
            from: from.lookup,
            data,
        }));
    }
    // --- V1 lock lifecycle (IZetoFungible_V1) ----------------------------------------------------------------
    // V1 replaces V0's lock/transferLocked pair: the spend recipients are pinned when the lock is created, so the
    // delegate's spendLock can be encoded and authorised ahead of time.
    createLock(from, data) {
        return new transaction_1.TransactionFuture(this.paladin, this.paladin.sendTransaction({
            type: interfaces_1.TransactionType.PRIVATE,
            abi: zetoAbiV1,
            function: "createLock",
            to: this.address,
            from: from.lookup,
            data: {
                from: data.from,
                recipients: data.recipients.map((t) => ({ ...t, to: t.to.lookup })),
                unlockData: data.unlockData,
                data: data.data,
            },
        }));
    }
    prepareSpendLock(from, data) {
        return new transaction_1.TransactionFuture(this.paladin, this.paladin.prepareTransaction({
            type: interfaces_1.TransactionType.PRIVATE,
            abi: zetoAbiV1,
            function: "spendLock",
            to: this.address,
            from: from.lookup,
            data,
        }));
    }
    // Hands the lock to a new spender. Only the current spender — the submitter of the public createLock — may call it.
    delegateLockV1(from, data) {
        return new transaction_1.TransactionFuture(this.paladin, this.paladin.sendTransaction({
            type: interfaces_1.TransactionType.PUBLIC,
            abi: zetoPublicAbi,
            function: "delegateLock",
            to: this.address,
            from: from.lookup,
            data,
        }));
    }
    delegateLock(from, data) {
        return new transaction_1.TransactionFuture(this.paladin, this.paladin.sendTransaction({
            type: interfaces_1.TransactionType.PUBLIC,
            abi: zetoPublicAbi,
            function: "delegateLock",
            to: this.address,
            from: from.lookup,
            data: {
                data: "0x",
                utxos: data.utxos,
                delegate: data.delegate,
            },
        }));
    }
    setERC20(from, data) {
        this.erc20 = data.erc20;
        return new transaction_1.TransactionFuture(this.paladin, this.paladin.sendTransaction({
            type: interfaces_1.TransactionType.PUBLIC,
            abi: zetoAbi,
            function: "setERC20",
            to: this.address,
            from: from.lookup,
            data,
        }));
    }
    deposit(from, data) {
        return new transaction_1.TransactionFuture(this.paladin, this.paladin.sendTransaction({
            type: interfaces_1.TransactionType.PRIVATE,
            abi: zetoAbi,
            function: "deposit",
            to: this.address,
            from: from.lookup,
            data,
        }));
    }
    withdraw(from, data) {
        return new transaction_1.TransactionFuture(this.paladin, this.paladin.sendTransaction({
            type: interfaces_1.TransactionType.PRIVATE,
            abi: zetoAbi,
            function: "withdraw",
            to: this.address,
            from: from.lookup,
            data,
        }));
    }
    async balanceOf(from, data) {
        return await this.paladin.call({
            type: interfaces_1.TransactionType.PRIVATE,
            domain: "zeto",
            abi: zetoPrivateJSON.abi,
            function: "balanceOf",
            to: this.address,
            from: from.lookup,
            data,
        });
    }
}
exports.ZetoInstance = ZetoInstance;
class ZetoNonFungibleInstance {
    constructor(paladin, address) {
        this.paladin = paladin;
        this.address = address;
    }
    using(paladin) {
        return new ZetoNonFungibleInstance(paladin, this.address);
    }
    mint(from, data) {
        return new transaction_1.TransactionFuture(this.paladin, this.paladin.sendTransaction({
            type: interfaces_1.TransactionType.PRIVATE,
            abi: zetoNonFungibleAbi,
            function: "mint",
            to: this.address,
            from: from.lookup,
            data: {
                mints: data.mints.map((m) => ({ ...m, to: m.to.lookup })),
            },
        }));
    }
    transfer(from, data) {
        return new transaction_1.TransactionFuture(this.paladin, this.paladin.sendTransaction({
            type: interfaces_1.TransactionType.PRIVATE,
            abi: zetoNonFungibleAbi,
            function: "transfer",
            to: this.address,
            from: from.lookup,
            data: {
                transfers: data.transfers.map((t) => ({ ...t, to: t.to.lookup })),
            },
        }));
    }
}
exports.ZetoNonFungibleInstance = ZetoNonFungibleInstance;
