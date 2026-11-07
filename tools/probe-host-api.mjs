import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {readFileSync,writeFileSync,mkdirSync} from 'node:fs';
import {dirname,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

// Explicit pinned local installation. Never discovers user credentials, profiles, or providers.
const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const executable='E:/dsh/DeepSeek Harness.exe',archive='E:/dsh/resources/app.asar';
const sha=path=>createHash('sha256').update(readFileSync(path)).digest('hex');
const hashes={executable:sha(executable),archive:sha(archive)};
if(hashes.executable!=='7ae939b5a82b220fbd8ad04dfbafaaedb5a49ab43dc884a5db6381f678dd0cc4'||hashes.archive!=='e1b6f25fa937da98086c3e77af77aa14791105963c4d337a1c42179d232c6915')throw new Error('Host differs from reviewed baseline');
const isolatedHome=resolve(root,'evidence/task3-isolated-home');mkdirSync(isolatedHome,{recursive:true});
const tap=resolve(root,'evidence/task3-host-contract.tap');
const args=['--expose-internals','--require',resolve(root,'tools/host-api/deny-network.cjs'),'--test','--test-concurrency=1','--test-reporter=tap',`--test-reporter-destination=${tap}`,resolve(root,'tools/host-api/probe.test.mjs')];
const artifacts=['tools/probe-host-api.mjs','tools/host-api/probe.test.mjs','tools/host-api/deny-network.cjs'].map(path=>({path,sha256:sha(resolve(root,path))}));
const startedAtUtc=new Date().toISOString(),started=performance.now();
const result=spawnSync(executable,args,{cwd:root,windowsHide:true,encoding:'utf8',timeout:30000,env:{SystemRoot:process.env.SystemRoot,TEMP:process.env.TEMP,TMP:process.env.TMP,ELECTRON_RUN_AS_NODE:'1',DSH_HOME:isolatedHome,DSH_TELEMETRY_DISABLED:'1',DSH_AUDIT_APP_ROOT:'E:/dsh/resources/app.asar/dsh'}});
const durationMs=performance.now()-started,tapText=readFileSync(tap,'utf8');
const tapSummary=Object.fromEntries(['tests','pass','fail','cancelled','skipped','todo'].map(key=>[key,Number(tapText.match(new RegExp(`^# ${key} (\\d+)\\r?$`,'m'))?.[1]??NaN)]));
const verified=result.status===0&&tapSummary.tests===10&&tapSummary.pass===10&&['fail','cancelled','skipped','todo'].every(key=>tapSummary[key]===0);
const report={schema_version:1,date:'2026-11-05',startedAtUtc,durationMs,purpose:'isolated installed-library API audit; not full Host activation',executable,archive,hashes,artifacts,args,exitCode:result.status,signal:result.signal,errorCode:result.error?.code??null,tapSummary,verified,profileLoaded:false,realProviderCalled:false,declarationBasis:'The two false flags follow the inspected probe call path: no profile boot or real adapter registration. They are not file-access or Provider-call monitoring results.',networkGuard:'tools/host-api/deny-network.cjs; covered API sinks only; not OS policy',tapSha256:sha(tap)};
writeFileSync(resolve(root,'evidence/task3-host-probe.json'),JSON.stringify(report,null,2)+'\n');
if(result.stderr)process.stderr.write(result.stderr);if(result.stdout)process.stdout.write(result.stdout);
process.stdout.write(JSON.stringify(report,null,2)+'\n');process.exitCode=verified?0:1;
