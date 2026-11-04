// Event fragments of the contracts the Besu models call (Zeto, Noto/Pente, Stealth), used to name the logs of a receipt
// (ARCHITECTURE.md §2.3 Receipts). Generated 2026-11-04 from the ABI file named on each line; several are build outputs a fresh
// checkout does not have, so the fragments are kept here. A log whose topic0 is not listed keeps its raw topic.
export const EVENT_ABI = [
  'event Announcement(uint256 indexed schemeId, address indexed stealthAddress, address indexed caller, bytes ephemeralPubKey, bytes metadata)', // besu/stealth-address/out/ERC5564Announcer.sol/ERC5564Announcer.json
  'event Approval(address indexed owner, address indexed spender, uint256 value)', // besu/stealth-address/out/RupiahDigital.sol/RupiahDigital.json
  'event ApprovalByPartition(bytes32 indexed partition, address indexed owner, address indexed spender, uint256 value)', // besu/stealth-address/out/DfabiBond.sol/DfabiBond.json
  'event AtomStatusChanged(uint8 status)', // besu/noto+pente/bond/build/bond/src/abis/Atom.json
  'event AuthorizedOperator(address indexed operator, address indexed tokenHolder)', // besu/stealth-address/out/DfabiBond.sol/DfabiBond.json
  'event AuthorizedOperatorByPartition(bytes32 indexed partition, address indexed operator, address indexed tokenHolder)', // besu/stealth-address/out/DfabiBond.sol/DfabiBond.json
  'event BondRefundFailed(bytes32 indexed tradeId)', // besu/stealth-address/out/DvPEscrow.sol/DvPEscrow.json
  'event Cancelled(bytes32 indexed tradeId, bool bondRefunded, uint256 rdRefunded)', // besu/stealth-address/out/DvPEscrow.sol/DvPEscrow.json
  'event ChangedPartition(bytes32 indexed fromPartition, bytes32 indexed toPartition, uint256 value)', // besu/stealth-address/out/DfabiBond.sol/DfabiBond.json
  'event DocumentRemoved(bytes32 indexed name, string uri, bytes32 documentHash)', // besu/stealth-address/out/DfabiBond.sol/DfabiBond.json
  'event DocumentUpdated(bytes32 indexed name, string uri, bytes32 documentHash)', // besu/stealth-address/out/DfabiBond.sol/DfabiBond.json
  'event EIP712DomainChanged()', // paladin:build-v1/paladin/sdk/typescript/src/domains/abis/PentePrivacyGroup.json
  'event Initialized(uint64 version)', // besu/noto+pente/bond/build/bond/src/abis/Atom.json
  'event Issued(address indexed operator, address indexed to, uint256 value, bytes data)', // besu/stealth-address/out/DfabiBond.sol/DfabiBond.json
  'event IssuedByPartition(bytes32 indexed partition, address indexed operator, address indexed to, uint256 value, bytes data, bytes operatorData)', // besu/stealth-address/out/DfabiBond.sol/DfabiBond.json
  'event LockCancelled(bytes32 indexed lockId, address indexed spender, bytes data)', // besu/noto+pente/common/build/common/paladin-client/src/abis/INoto.json
  'event LockCreated(bytes32 indexed lockId, address indexed owner, address indexed spender, bytes32 spendCommitment, bytes32 cancelCommitment, bytes data)', // besu/noto+pente/common/build/common/paladin-client/src/abis/INoto.json
  'event LockDelegated(bytes32 indexed lockId, address indexed previousSpender, address indexed newSpender, bytes data)', // besu/noto+pente/common/build/common/paladin-client/src/abis/INoto.json
  'event LockSpent(bytes32 indexed lockId, address indexed spender, bytes data)', // besu/noto+pente/common/build/common/paladin-client/src/abis/INoto.json
  'event LockUpdated(bytes32 indexed lockId, address indexed owner, bytes32 spendCommitment, bytes32 cancelCommitment, bytes data)', // besu/noto+pente/common/build/common/paladin-client/src/abis/INoto.json
  'event MinterAdded(address indexed account)', // besu/stealth-address/out/DfabiBond.sol/DfabiBond.json
  'event MinterRemoved(address indexed account)', // besu/stealth-address/out/DfabiBond.sol/DfabiBond.json
  'event NotoLockCancelled(bytes32 indexed txId, bytes32 indexed lockId, address indexed spender, bytes32[] inputs, bytes32[] outputs, bytes txData, bytes32 oldLockState, bytes proof, bytes data)', // besu/noto+pente/common/build/common/paladin-client/src/abis/INoto.json
  'event NotoLockCreated(bytes32 indexed txId, bytes32 indexed lockId, address indexed owner, bytes32[] inputs, bytes32[] outputs, bytes32[] contents, bytes32 newLockState, bytes proof, bytes data)', // besu/noto+pente/common/build/common/paladin-client/src/abis/INoto.json
  'event NotoLockDelegated(bytes32 indexed txId, bytes32 indexed lockId, address indexed previousSpender, address newSpender, bytes32 oldLockState, bytes32 newLockState, bytes proof, bytes data)', // besu/noto+pente/common/build/common/paladin-client/src/abis/INoto.json
  'event NotoLockSpent(bytes32 indexed txId, bytes32 indexed lockId, address indexed spender, bytes32[] inputs, bytes32[] outputs, bytes txData, bytes32 oldLockState, bytes proof, bytes data)', // besu/noto+pente/common/build/common/paladin-client/src/abis/INoto.json
  'event NotoLockUpdated(bytes32 indexed txId, bytes32 indexed lockId, address indexed owner, bytes32[] contents, bytes32 oldLockState, bytes32 newLockState, bytes proof, bytes data)', // besu/noto+pente/common/build/common/paladin-client/src/abis/INoto.json
  'event OwnershipTransferred(address indexed previousOwner, address indexed newOwner)', // besu/stealth-address/out/DfabiBond.sol/DfabiBond.json
  'event PenteApproved(bytes32 txId, address delegate, bytes32 transitionHash)', // paladin:build-v1/paladin/sdk/typescript/src/domains/abis/PentePrivacyGroup.json
  'event PenteTransition(bytes32 txId, bytes32[] inputs, bytes32[] reads, bytes32[] outputs, bytes32[] info)', // paladin:build-v1/paladin/sdk/typescript/src/domains/abis/PentePrivacyGroup.json
  'event Redeemed(address indexed operator, address indexed from, uint256 value, bytes data)', // besu/stealth-address/out/DfabiBond.sol/DfabiBond.json
  'event RedeemedByPartition(bytes32 indexed partition, address indexed operator, address indexed from, uint256 value, bytes operatorData)', // besu/stealth-address/out/DfabiBond.sol/DfabiBond.json
  'event RevokedOperator(address indexed operator, address indexed tokenHolder)', // besu/stealth-address/out/DfabiBond.sol/DfabiBond.json
  'event RevokedOperatorByPartition(bytes32 indexed partition, address indexed operator, address indexed tokenHolder)', // besu/stealth-address/out/DfabiBond.sol/DfabiBond.json
  'event Settled(bytes32 indexed tradeId)', // besu/stealth-address/out/DvPEscrow.sol/DvPEscrow.json
  'event Transfer(address indexed from, address indexed to, uint256 value)', // besu/stealth-address/out/RupiahDigital.sol/RupiahDigital.json
  'event Transfer(bytes32 txId, address indexed operator, bytes32[] inputs, bytes32[] outputs, bytes proof, bytes data)', // besu/noto+pente/common/build/common/paladin-client/src/abis/INoto.json
  'event TransferByPartition(bytes32 indexed fromPartition, address operator, address indexed from, address indexed to, uint256 value, bytes data, bytes operatorData)', // besu/stealth-address/out/DfabiBond.sol/DfabiBond.json
  'event Upgraded(address indexed implementation)', // paladin:build-v1/paladin/sdk/typescript/src/domains/abis/PentePrivacyGroup.json
  'event UTXOBurn(uint256[] inputs, uint256 output, address indexed submitter, bytes data)', // besu/zeto/abis/IZeto.json
  'event UTXOMint(uint256[] outputs, address indexed submitter, bytes data)', // besu/zeto/abis/IZeto.json
  'event UTXOTransfer(uint256[] inputs, uint256[] outputs, address indexed submitter, bytes data)', // besu/zeto/abis/IZeto.json
  'event UTXOTransferWithEncryptedValues(uint256[] inputs, uint256[] outputs, uint256 encryptionNonce, uint256[2] ecdhPublicKey, uint256[] encryptedValues, address indexed submitter, bytes data)', // besu/zeto/abis/IZeto.json
  'event UTXOWithdraw(uint256 amount, uint256[] inputs, uint256 output, address indexed submitter, bytes data)', // besu/zeto/abis/IZeto.json
  'event ZetoLockCancelled(bytes32 indexed txId, bytes32 indexed lockId, address indexed spender, uint256[] lockedInputs, uint256[] lockedOutputs, uint256[] outputs, bytes proof, bytes data)', // besu/zeto/abis/ZetoV1Events.json
  'event ZetoLockCreated(bytes32 indexed txId, bytes32 indexed lockId, address indexed owner, uint256[] inputs, uint256[] outputs, uint256[] lockedOutputs, bytes proof, bytes data)', // besu/zeto/abis/ZetoV1Events.json
  'event ZetoLockDelegated(bytes32 indexed txId, bytes32 indexed lockId, address indexed from, address to, bytes data)', // besu/zeto/abis/ZetoV1Events.json
  'event ZetoLockSpent(bytes32 indexed txId, bytes32 indexed lockId, address indexed spender, uint256[] lockedInputs, uint256[] lockedOutputs, uint256[] outputs, bytes proof, bytes data)', // besu/zeto/abis/ZetoV1Events.json
  'event ZetoLockUpdated(bytes32 indexed txId, bytes32 indexed lockId, address indexed owner, bytes data)', // besu/zeto/abis/ZetoV1Events.json
];
