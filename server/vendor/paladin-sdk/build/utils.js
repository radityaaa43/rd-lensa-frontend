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
exports.encodeStates = void 0;
exports.encodeHex = encodeHex;
exports.decodeHex = decodeHex;
exports.newTransactionId = newTransactionId;
const uuid = __importStar(require("uuid"));
function encodeHex(data) {
    return "0x" + Buffer.from(data, "utf8").toString("hex");
}
function decodeHex(data) {
    return Buffer.from(data.slice(2), "hex").toString("utf8");
}
function newTransactionId() {
    return encodeHex(uuid.v4()) + "00000000000000000000000000000000";
}
const encodeStates = (states) => {
    return states.map((state) => ({
        id: state.id,
        domain: state.domain,
        schema: state.schema,
        contractAddress: state.contractAddress,
        data: encodeHex(JSON.stringify(state.data)),
    }));
};
exports.encodeStates = encodeStates;
