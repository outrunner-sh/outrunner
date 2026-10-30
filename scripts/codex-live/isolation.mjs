// Inspect only our fresh test containers. Never print environment values.
import { execFileSync } from "node:child_process";
const probe = String.raw`
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
for(const key of ['SUPABASE_SERVICE_ROLE_KEY','CREDENTIALS_ENCRYPTION_KEY','RUNTIME_AGENT_MEMBER_SECRET','NEXT_PUBLIC_SUPABASE_URL'])assert.equal(key in process.env,false,'Controller config must not reach computers');
assert.equal(fs.existsSync('/home/user/workspaces/outrunner/.context/codex-live/secrets.json'),false,'Controller files must not be mounted');
assert.equal((await fetch('http://127.0.0.1:3408/api/settings/codex')).status,404,'Socket relay must deny management APIs');
assert.equal((await fetch('http://127.0.0.1:3408/api/runtime/codex/models')).status,403,'Actual broker must require a grant');
const reachable=await new Promise(resolve=>{const s=net.connect({host:'172.17.0.1',port:55422});s.on('connect',()=>{s.destroy();resolve(true);});s.on('error',()=>resolve(false));s.setTimeout(1000,()=>{s.destroy();resolve(false);});});
assert.equal(reachable,false,'Computer must not reach the database network');
console.log('PASS computer has no controller config/files/network; inference-only relay enforces broker auth');
`;
for (const name of ["computer-a", "computer-b"]) {
  const result = execFileSync(
    "docker",
    [
      "exec",
      "outrunner-codex-live-" + name,
      "node",
      "--input-type=module",
      "-e",
      probe,
    ],
    { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
  );
  process.stdout.write(name + ": " + result);
}
