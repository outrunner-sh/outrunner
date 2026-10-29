import assert from "node:assert/strict";
import { test } from "node:test";
import { runnerRequest } from "@/lib/missions/runner-request";
import type { RunnerStart } from "@/lib/missions/tools";
import type { Workspace } from "@/lib/runtime/types";
const start: RunnerStart = { brief: "Do the work", planMode: false, name: undefined, model: undefined, agent: undefined, effort: undefined };
const parent: Pick<Workspace,"model"|"agent"> = { agent:"codex", model:{model:{provider:"codex",id:"account-code",label:"Account model"},effort:"high"} };
test("a Runner keeps its parent's explicit runtime selection",()=>{
 assert.deepEqual(runnerRequest(parent,start),{provider:"codex",model:"account-code",agent:"codex",effort:"high",prompt:"Do the work"});
});
test("a Runner harness override drops incompatible inherited model and effort",()=>{
 assert.deepEqual(runnerRequest(parent,{...start,agent:"claude"}),{agent:"claude",prompt:"Do the work"});
});
test("a Runner's new model selects its compatible harness and drops inherited effort",()=>{
 assert.deepEqual(runnerRequest(parent,{...start,model:"sonnet"}),{provider:"claude",model:"sonnet",agent:"claude",prompt:"Do the work"});
});
test("an explicit Runner effort is validated by creation, never replaced by inheritance",()=>{
 assert.equal(runnerRequest(parent,{...start,effort:"low"}).effort,"low");
});
