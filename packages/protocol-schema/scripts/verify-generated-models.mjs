import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const schemaPath = path.join(packageRoot, "remote-protocol.schema.json");
const manifestPath = path.join(packageRoot, "fixtures", "manifest.json");
const generatedPath = path.join(packageRoot, "generated", "RemoteProtocol.swift");

function readJson(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (error) {
    throw new Error(`无法读取 JSON ${path.relative(packageRoot, filePath)}：${error.message}`);
  }
}

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function requireValue(condition, message, errors) {
  if (!condition) errors.push(message);
}

const knownClientMethods = new Set([
  "connection.info",
  "workspace.list",
  "thread.list",
  "thread.read",
  "thread.create",
  "thread.delete",
  "thread.resume",
  "turn.start",
  "turn.interrupt",
  "approval.resolve",
  "events.resume",
  "events.ack",
  "pairing.complete",
  "device.list",
  "device.revoke",
  "mock.fault.configure",
  "mock.fault.release",
]);

const knownEventMethods = new Set([
  "connection.status",
  "thread.list.snapshot",
  "thread.snapshot",
  "thread.upsert",
  "thread.removed",
  "turn.started",
  "turn.completed",
  "item.upsert",
  "item.delta",
  "turn.diff.updated",
  "approval.requested",
  "approval.resolved",
  "error",
  "raw",
]);

function validateSchema(schema, errors) {
  requireValue(schema.$schema === "https://json-schema.org/draft/2020-12/schema", "schema 未声明 draft 2020-12", errors);
  requireValue(typeof schema.$id === "string" && schema.$id.includes("/v1/"), "schema $id 必须包含版本路径 /v1/", errors);
  requireValue(schema["x-protocol-version"] === "1.0.0", "schema x-protocol-version 必须为 1.0.0", errors);
  requireValue(isObject(schema.$defs), "schema 缺少 $defs", errors);
  for (const name of [
    "jsonValue",
    "clientRequest",
    "clientRequestBase",
    "serverResponse",
    "eventEnvelope",
    "remoteEvent",
    "remoteEventBase",
    "threadSummary",
    "remoteTurn",
    "remoteThread",
    "remoteItem",
    "attachment",
    "approval",
    "turnStartParams",
    "threadListSnapshotParams",
    "itemUpsertParams",
    "itemDeltaParams",
    "turnDiffUpdatedParams",
    "approvalRequestedParams",
  ]) {
    requireValue(isObject(schema.$defs?.[name]), `schema 缺少 $defs.${name}`, errors);
  }
  requireValue(Array.isArray(schema.$defs?.clientRequest?.oneOf), "schema $defs.clientRequest 必须使用 oneOf 区分已知请求方法", errors);
  requireValue(Array.isArray(schema.$defs?.remoteEvent?.oneOf), "schema $defs.remoteEvent 必须使用 oneOf 区分已知事件方法", errors);
  requireValue(schema.$defs?.clientRequest?.oneOf?.length >= knownClientMethods.size + 1, "clientRequest oneOf 未覆盖全部已知请求方法和 unknown 分支", errors);
  requireValue(schema.$defs?.remoteEvent?.oneOf?.length >= knownEventMethods.size + 1, "remoteEvent oneOf 未覆盖全部已知事件方法和 unknown 分支", errors);
}

function validateFixture(entry, value, errors) {
  requireValue(isObject(value), `${entry.id}: 根节点必须是对象`, errors);
  if (!isObject(value)) return;

  requireValue(value.kind === entry.kind, `${entry.id}: kind 应为 ${entry.kind}`, errors);
  requireValue(typeof value.kind === "string", `${entry.id}: 缺少 kind`, errors);

  if (entry.kind === "event") {
    requireValue(knownEventMethods.has(entry.wireMethod), `${entry.id}: schema 未登记事件方法 ${entry.wireMethod}`, errors);
    requireValue(Number.isInteger(value.sequence) && value.sequence >= 0, `${entry.id}: sequence 必须是非负整数`, errors);
    requireValue(typeof value.eventId === "string" && value.eventId.length > 0, `${entry.id}: eventId 必须非空`, errors);
    requireValue(isObject(value.event), `${entry.id}: 缺少 event 对象`, errors);
    if (isObject(value.event)) {
      requireValue(value.event.method === entry.wireMethod, `${entry.id}: event.method 应为 ${entry.wireMethod}`, errors);
      requireValue(isObject(value.event.params), `${entry.id}: event.params 必须是对象`, errors);
    }
  }

  if (entry.kind === "request") {
    requireValue(knownClientMethods.has(entry.wireMethod), `${entry.id}: schema 未登记请求方法 ${entry.wireMethod}`, errors);
    requireValue(typeof value.id === "string" && value.id.length > 0, `${entry.id}: request.id 必须非空`, errors);
    requireValue(value.method === entry.wireMethod, `${entry.id}: method 应为 ${entry.wireMethod}`, errors);
    requireValue(isObject(value.params), `${entry.id}: params 必须是对象`, errors);
  }

  if (entry.id === "thread-list.snapshot") {
    requireValue(Array.isArray(value.event?.params?.threads), `${entry.id}: threads 必须是数组`, errors);
  }
  if (entry.id === "turn.plan.updated") {
    requireValue(value.event?.params?.item?.type === "plan", `${entry.id}: item.type 必须是 plan`, errors);
  }
  if (entry.id === "tool.progress") {
    requireValue(value.event?.params?.target === "toolOutput", `${entry.id}: target 必须是 toolOutput`, errors);
  }
  if (entry.id === "turn.diff.updated") {
    requireValue(typeof value.event?.params?.diff === "string", `${entry.id}: diff 必须是字符串`, errors);
  }
  if (entry.id === "turn.attachment") {
    requireValue(Array.isArray(value.params?.attachments), `${entry.id}: attachments 必须是数组`, errors);
  }
  if (entry.id === "approval.requested") {
    requireValue(isObject(value.event?.params?.approval), `${entry.id}: approval 必须是对象`, errors);
  }
  if (entry.id === "turn.failed") {
    requireValue(value.event?.params?.turn?.status === "failed", `${entry.id}: turn.status 必须是 failed`, errors);
  }
}

const schema = readJson(schemaPath);
const manifest = readJson(manifestPath);
const errors = [];

validateSchema(schema, errors);
requireValue(manifest.manifestVersion === 1, "fixture manifestVersion 必须为 1", errors);
requireValue(manifest.protocolVersion === schema["x-protocol-version"], "fixture manifest 与 schema 版本不一致", errors);
requireValue(Array.isArray(manifest.fixtures) && manifest.fixtures.length > 0, "fixture 清单不能为空", errors);
requireValue(fs.existsSync(generatedPath), "缺少 generated/RemoteProtocol.swift", errors);
if (fs.existsSync(generatedPath)) {
  const generated = fs.readFileSync(generatedPath, "utf8");
  requireValue(generated.includes('schemaVersion = "1.0.0"'), "generated/RemoteProtocol.swift 未标记 schema 版本", errors);
}

const seenIDs = new Set();
for (const entry of manifest.fixtures ?? []) {
  requireValue(isObject(entry), "fixture 清单项必须是对象", errors);
  if (!isObject(entry)) continue;
  requireValue(typeof entry.id === "string" && entry.id.length > 0, "fixture 清单项缺少 id", errors);
  requireValue(!seenIDs.has(entry.id), `fixture id 重复：${entry.id}`, errors);
  seenIDs.add(entry.id);
  const fixturePath = path.resolve(path.dirname(manifestPath), manifest.sourceRoot, entry.file);
  requireValue(fs.existsSync(fixturePath), `${entry.id}: 找不到 ${path.relative(packageRoot, fixturePath)}`, errors);
  if (fs.existsSync(fixturePath)) validateFixture(entry, readJson(fixturePath), errors);
}

if (process.argv.includes("--generate")) {
  console.log("生成器占位：schema 与夹具已通过静态检查，Swift 模型生成将在后续阶段接入。");
}

if (errors.length > 0) {
  console.error(errors.map((error) => `- ${error}`).join("\n"));
  process.exitCode = 1;
} else {
  console.log(`协议 schema 校验通过：${manifest.fixtures.length} 个夹具，版本 ${schema["x-protocol-version"]}。`);
}
