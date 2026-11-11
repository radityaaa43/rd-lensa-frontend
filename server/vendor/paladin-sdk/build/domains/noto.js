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
exports.NotoInstance = exports.NotoFactory = exports.NotoFuture = exports.notoConstructorABI = void 0;
const ethers_1 = require("ethers");
const interfaces_1 = require("../interfaces");
const notoJSON = __importStar(require("./abis/INoto.json"));
const notoPrivateJSON = __importStar(require("./abis/INotoPrivate.json"));
const transaction_1 = require("../transaction");
const notoConstructorABI = (withHooks) => ({
    type: "constructor",
    inputs: [
        { name: "name", type: "string" },
        { name: "symbol", type: "string" },
        { name: "notary", type: "string" },
        { name: "notaryMode", type: "string" },
        {
            name: "options",
            type: "tuple",
            components: [
                ...(withHooks
                    ? [
                        {
                            name: "hooks",
                            type: "tuple",
                            components: [
                                {
                                    name: "privateGroup",
                                    type: "tuple",
                                    components: [
                                        { name: "salt", type: "bytes32" },
                                        { name: "members", type: "string[]" },
                                    ],
                                },
                                { name: "publicAddress", type: "address" },
                                { name: "privateAddress", type: "address" },
                            ],
                        },
                    ]
                    : [
                        {
                            name: "basic",
                            type: "tuple",
                            components: [
                                { name: "restrictMint", type: "bool" },
                                { name: "allowBurn", type: "bool" },
                                { name: "allowLock", type: "bool" },
                            ],
                        },
                    ]),
            ],
        },
    ],
});
exports.notoConstructorABI = notoConstructorABI;
// Represents an in-flight Noto deployment
class NotoFuture extends transaction_1.TransactionFuture {
    async waitForDeploy(waitMs) {
        const receipt = await this.waitForReceipt(waitMs);
        return receipt?.contractAddress
            ? new NotoInstance(this.paladin, receipt.contractAddress)
            : undefined;
    }
}
exports.NotoFuture = NotoFuture;
class NotoFactory {
    constructor(paladin, domain) {
        this.paladin = paladin;
        this.domain = domain;
    }
    using(paladin) {
        return new NotoFactory(paladin, this.domain);
    }
    newNoto(from, data, idempotencyKey) {
        return new NotoFuture(this.paladin, this.paladin.ptx.sendTransaction({
            idempotencyKey,
            type: interfaces_1.TransactionType.PRIVATE,
            domain: this.domain,
            abi: [(0, exports.notoConstructorABI)(!!data.options?.hooks)],
            function: "",
            from: from.lookup,
            data: {
                ...data,
                name: data.name ?? "",
                symbol: data.symbol ?? "",
                notary: data.notary.lookup,
                options: {
                    basic: {
                        restrictMint: true,
                        allowBurn: true,
                        allowLock: true,
                        ...data.options?.basic,
                    },
                    ...data.options,
                },
            },
        }));
    }
}
exports.NotoFactory = NotoFactory;
class NotoInstance {
    constructor(paladin, address) {
        this.paladin = paladin;
        this.address = address;
    }
    using(paladin) {
        return new NotoInstance(paladin, this.address);
    }
    mint(from, data, idempotencyKey) {
        return new transaction_1.TransactionFuture(this.paladin, this.paladin.ptx.sendTransaction({
            idempotencyKey,
            type: interfaces_1.TransactionType.PRIVATE,
            abi: notoPrivateJSON.abi,
            function: "mint",
            to: this.address,
            from: from.lookup,
            data: {
                ...data,
                to: data.to.lookup,
            },
        }));
    }
    transfer(from, data, idempotencyKey) {
        return new transaction_1.TransactionFuture(this.paladin, this.paladin.ptx.sendTransaction({
            idempotencyKey,
            type: interfaces_1.TransactionType.PRIVATE,
            abi: notoPrivateJSON.abi,
            function: "transfer",
            to: this.address,
            from: from.lookup,
            data: {
                ...data,
                to: data.to.lookup,
            },
        }));
    }
    transferFrom(from, data, idempotencyKey) {
        return new transaction_1.TransactionFuture(this.paladin, this.paladin.ptx.sendTransaction({
            idempotencyKey,
            type: interfaces_1.TransactionType.PRIVATE,
            abi: notoPrivateJSON.abi,
            function: "transferFrom",
            to: this.address,
            from: from.lookup,
            data: {
                ...data,
                from: data.from.lookup,
                to: data.to.lookup,
            },
        }));
    }
    burn(from, data, idempotencyKey) {
        return new transaction_1.TransactionFuture(this.paladin, this.paladin.ptx.sendTransaction({
            idempotencyKey,
            type: interfaces_1.TransactionType.PRIVATE,
            abi: notoPrivateJSON.abi,
            function: "burn",
            to: this.address,
            from: from.lookup,
            data,
        }));
    }
    burnFrom(from, data, idempotencyKey) {
        return new transaction_1.TransactionFuture(this.paladin, this.paladin.ptx.sendTransaction({
            idempotencyKey,
            type: interfaces_1.TransactionType.PRIVATE,
            abi: notoPrivateJSON.abi,
            function: "burnFrom",
            to: this.address,
            from: from.lookup,
            data: {
                ...data,
                from: data.from.lookup,
            },
        }));
    }
    // @deprecated - use createLock instead
    lock(from, data, idempotencyKey) {
        return new transaction_1.TransactionFuture(this.paladin, this.paladin.ptx.sendTransaction({
            idempotencyKey,
            type: interfaces_1.TransactionType.PRIVATE,
            abi: notoPrivateJSON.abi,
            function: "lock",
            to: this.address,
            from: from.lookup,
            data,
        }));
    }
    createLock(from, data, idempotencyKey) {
        return new transaction_1.TransactionFuture(this.paladin, this.paladin.ptx.sendTransaction({
            idempotencyKey,
            type: interfaces_1.TransactionType.PRIVATE,
            abi: notoPrivateJSON.abi,
            function: "createLock",
            to: this.address,
            from: from.lookup,
            data,
        }));
    }
    createTransferLock(from, data, idempotencyKey) {
        return new transaction_1.TransactionFuture(this.paladin, this.paladin.ptx.sendTransaction({
            idempotencyKey,
            type: interfaces_1.TransactionType.PRIVATE,
            abi: notoPrivateJSON.abi,
            function: "createTransferLock",
            to: this.address,
            from: from.lookup,
            data: {
                ...data,
                from: data.from.lookup,
                recipients: data.recipients.map((recipient) => ({
                    to: recipient.to.lookup,
                    amount: recipient.amount,
                })),
            },
        }));
    }
    createMintLock(from, data, idempotencyKey) {
        return new transaction_1.TransactionFuture(this.paladin, this.paladin.ptx.sendTransaction({
            idempotencyKey,
            type: interfaces_1.TransactionType.PRIVATE,
            abi: notoPrivateJSON.abi,
            function: "createMintLock",
            to: this.address,
            from: from.lookup,
            data: {
                ...data,
                recipients: data.recipients.map((recipient) => ({
                    to: recipient.to.lookup,
                    amount: recipient.amount,
                })),
            },
        }));
    }
    createBurnLock(from, data, idempotencyKey) {
        return new transaction_1.TransactionFuture(this.paladin, this.paladin.ptx.sendTransaction({
            idempotencyKey,
            type: interfaces_1.TransactionType.PRIVATE,
            abi: notoPrivateJSON.abi,
            function: "createBurnLock",
            to: this.address,
            from: from.lookup,
            data: {
                ...data,
                from: data.from.lookup,
            },
        }));
    }
    unlock(from, data, idempotencyKey) {
        return new transaction_1.TransactionFuture(this.paladin, this.paladin.ptx.sendTransaction({
            idempotencyKey,
            type: interfaces_1.TransactionType.PRIVATE,
            abi: notoPrivateJSON.abi,
            function: "unlock",
            to: this.address,
            from: from.lookup,
            data: {
                ...data,
                from: data.from.lookup,
                recipients: data.recipients.map((recipient) => ({
                    to: recipient.to.lookup,
                    amount: recipient.amount,
                })),
            },
        }));
    }
    spendLock(from, data, idempotencyKey) {
        return new transaction_1.TransactionFuture(this.paladin, this.paladin.ptx.sendTransaction({
            idempotencyKey,
            type: interfaces_1.TransactionType.PUBLIC,
            abi: notoJSON.abi,
            function: "spendLock",
            to: this.address,
            from: from.lookup,
            data,
        }));
    }
    cancelLock(from, data, idempotencyKey) {
        return new transaction_1.TransactionFuture(this.paladin, this.paladin.ptx.sendTransaction({
            idempotencyKey,
            type: interfaces_1.TransactionType.PUBLIC,
            abi: notoJSON.abi,
            function: "cancelLock",
            to: this.address,
            from: from.lookup,
            data,
        }));
    }
    prepareUnlock(from, data, idempotencyKey) {
        return new transaction_1.TransactionFuture(this.paladin, this.paladin.ptx.sendTransaction({
            idempotencyKey,
            type: interfaces_1.TransactionType.PRIVATE,
            abi: notoPrivateJSON.abi,
            function: "prepareUnlock",
            to: this.address,
            from: from.lookup,
            data: {
                ...data,
                from: data.from.lookup,
                recipients: data.recipients.map((recipient) => ({
                    to: recipient.to.lookup,
                    amount: recipient.amount,
                })),
            },
        }));
    }
    prepareMintUnlock(from, data, idempotencyKey) {
        return new transaction_1.TransactionFuture(this.paladin, this.paladin.ptx.sendTransaction({
            idempotencyKey,
            type: interfaces_1.TransactionType.PRIVATE,
            abi: notoPrivateJSON.abi,
            function: "prepareMintUnlock",
            to: this.address,
            from: from.lookup,
            data: {
                ...data,
                recipients: data.recipients.map((recipient) => ({
                    to: recipient.to.lookup,
                    amount: recipient.amount,
                })),
            },
        }));
    }
    prepareBurnUnlock(from, data, idempotencyKey) {
        return new transaction_1.TransactionFuture(this.paladin, this.paladin.ptx.sendTransaction({
            idempotencyKey,
            type: interfaces_1.TransactionType.PRIVATE,
            abi: notoPrivateJSON.abi,
            function: "prepareBurnUnlock",
            to: this.address,
            from: from.lookup,
            data: {
                ...data,
                from: data.from.lookup,
            },
        }));
    }
    delegateLock(from, data, idempotencyKey) {
        return new transaction_1.TransactionFuture(this.paladin, this.paladin.ptx.sendTransaction({
            idempotencyKey,
            type: interfaces_1.TransactionType.PRIVATE,
            abi: notoPrivateJSON.abi,
            function: "delegateLock",
            to: this.address,
            from: from.lookup,
            data,
        }));
    }
    encodeSpendLock(data) {
        return new ethers_1.ethers.Interface(notoJSON.abi).encodeFunctionData("spendLock", [data.lockId, data.spendArgs, data.data]);
    }
    encodeCancelLock(data) {
        return new ethers_1.ethers.Interface(notoJSON.abi).encodeFunctionData("cancelLock", [data.lockId, data.cancelArgs, data.data]);
    }
    name(from) {
        return this.paladin.call({
            type: interfaces_1.TransactionType.PRIVATE,
            domain: "noto",
            abi: notoPrivateJSON.abi,
            function: "name",
            to: this.address,
            from: from.lookup,
            data: {},
        });
    }
    symbol(from) {
        return this.paladin.call({
            type: interfaces_1.TransactionType.PRIVATE,
            domain: "noto",
            abi: notoPrivateJSON.abi,
            function: "symbol",
            to: this.address,
            from: from.lookup,
            data: {},
        });
    }
    decimals(from) {
        return this.paladin.call({
            type: interfaces_1.TransactionType.PRIVATE,
            domain: "noto",
            abi: notoPrivateJSON.abi,
            function: "decimals",
            to: this.address,
            from: from.lookup,
            data: {},
        });
    }
    balanceOf(from, data) {
        return this.paladin.call({
            type: interfaces_1.TransactionType.PRIVATE,
            domain: "noto",
            abi: notoPrivateJSON.abi,
            function: "balanceOf",
            to: this.address,
            from: from.lookup,
            data,
        });
    }
}
exports.NotoInstance = NotoInstance;
