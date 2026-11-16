// bosai-checklist/index.html をヘッドレスEdgeで実際に操作して確かめるテスト（Chrome DevTools Protocol、npm依存なし）。
// 使い方（bosai-checklistフォルダで）: node tests/browser_check.mjs index.html
// Windows の Microsoft Edge が必要。失敗があれば終了コード1。
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const EDGE = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
const PORT = 20000 + Math.floor(Math.random() * 20000);
const page = pathToFileURL(resolve(process.argv[2])).href;
const profile = mkdtempSync(join(tmpdir(), "bosai-edge-"));
const edge = spawn(EDGE, ["--headless=new", `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`, "--no-first-run", "about:blank"], { stdio: "ignore" });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let targets;
for (let i = 0; i < 50; i++) {
  try { targets = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json(); break; } catch { await sleep(200); }
}
const ws = new WebSocket(targets.find((t) => t.type === "page").webSocketDebuggerUrl);
await new Promise((r) => ws.addEventListener("open", r, { once: true }));
let seq = 0; const pending = new Map();
ws.addEventListener("message", (ev) => { const m = JSON.parse(ev.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } });
const send = (method, params = {}) => new Promise((r) => { const id = ++seq; pending.set(id, r); ws.send(JSON.stringify({ id, method, params })); });
const evalJs = async (expr) => { const r = await send("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true }); if (r.result.exceptionDetails) throw new Error(JSON.stringify(r.result.exceptionDetails)); return r.result.result.value; };
const nav = async () => { await send("Page.navigate", { url: page }); await sleep(800); };
// confirm/alert are stubbed after each load (dialogs would block headless runs)
const stub = () => evalJs(`window.__alerts=[];window.confirm=()=>true;window.alert=(m)=>window.__alerts.push(String(m));true`);

await send("Page.enable"); await send("Runtime.enable");
// window.name が 'fail-get-once' のときだけ、ページ起動時の localStorage 読み取りを1回失敗させる（保存機能なしの再現用）
await send("Page.addScriptToEvaluateOnNewDocument", { source: `if (window.name === 'fail-get-once') { window.name = ''; const g = Storage.prototype.getItem; let n = 0; Storage.prototype.getItem = function (...a) { if (n++ === 0) throw new Error('blocked'); return g.apply(this, a); }; }` });
const results = []; const check = (name, ok, detail = "") => results.push({ name, ok: !!ok, detail });

try {
await nav(); await evalJs("localStorage.clear();true"); await nav(); await stub();
check("初期表示で既定18項目", (await evalJs("document.querySelectorAll('#itemList .item').length")) === 18);

await evalJs(`(()=>{const f=document.getElementById('addForm');f.elements.name.value='テスト電池';f.elements.qty.value='4本';f.elements.expiry.value='2000-01-01';f.requestSubmit();return true})()`);
check("項目追加→19項目", (await evalJs("document.querySelectorAll('#itemList .item').length")) === 19);
check("過去日付は期限切れ表示", (await evalJs("[...document.querySelectorAll('.expiry-status.danger')].length")) >= 1);

await evalJs("document.querySelector('#itemList .item input[type=checkbox]').click();true");
await nav(); await stub();
check("再読み込み後もチェック・追加が残る", await evalJs("JSON.parse(localStorage.getItem('bosaiChecklist_v1')).items.length===19 && document.querySelector('#itemList .item input[type=checkbox]').checked"));

await evalJs("document.getElementById('finishBtn').click();true");
check("点検完了で全チェック解除・日時記録", await evalJs("(()=>{const s=JSON.parse(localStorage.getItem('bosaiChecklist_v1'));return s.items.every(i=>!i.checked)&&typeof s.lastInspectionAt==='string'})()"));

const xss = `<img src=x onerror="window.__xss=1">`;
await evalJs(`(()=>{const s=JSON.parse(localStorage.getItem('bosaiChecklist_v1'));s.items[0].name=${JSON.stringify(xss)};localStorage.setItem('bosaiChecklist_v1',JSON.stringify(s));return true})()`);
await nav(); await stub(); await sleep(300);
check("項目名にHTMLを入れても実行されない", !(await evalJs("window.__xss===1")));

await evalJs("localStorage.setItem('bosaiChecklist_v1','{broken');true"); await nav(); await stub();
check("壊れたデータでも元データを上書きしない", (await evalJs("localStorage.getItem('bosaiChecklist_v1')")) === "{broken" && (await evalJs("document.querySelectorAll('.banner.error').length")) === 1);

// ---- 2026-11-16 修正分 ----
const KEY = "'bosaiChecklist_v1'";
const reset = async () => { await evalJs("localStorage.clear();true"); await nav(); await stub(); };
const stored = () => evalJs(`JSON.parse(localStorage.getItem(${KEY}))`);

// 1. 別タブの変更を上書きしない
await reset();
await evalJs("document.querySelector('#itemList .item input[type=checkbox]').click();true"); // 保存データを作る
await evalJs(`(()=>{const s=JSON.parse(localStorage.getItem(${KEY}));s.items[1].name='別タブで変更';localStorage.setItem(${KEY},JSON.stringify(s));return true})()`);
await evalJs("document.querySelectorAll('#itemList .item input[type=checkbox]')[2].click();true");
let s = await stored();
check("別タブの変更が残る", s.items[1].name === "別タブで変更");
check("別タブの変更を画面に表示", (await evalJs("document.querySelectorAll('#itemList .name')[1].value")) === "別タブで変更");
check("別タブ変更の案内を表示", (await evalJs("document.getElementById('bannerArea').textContent")).includes("別のタブ"));

// 2. 保存できない点検完了は取り消す
await reset();
await evalJs("document.querySelector('#itemList .item input[type=checkbox]').click();true");
await evalJs("Storage.prototype._set=Storage.prototype.setItem;Storage.prototype.setItem=function(){throw new Error('full')};true");
await evalJs("document.getElementById('finishBtn').click();true");
check("保存失敗時はチェックを維持", await evalJs("document.querySelector('#itemList .item input[type=checkbox]').checked"));
check("保存失敗時は未点検のまま", (await evalJs("document.getElementById('lastInspection').textContent")).includes("未点検"));
check("保存失敗の案内を表示", (await evalJs("document.getElementById('bannerArea').textContent")).includes("保存に失敗"));
// 3. 保存が成功したら失敗の案内を消す
await evalJs("Storage.prototype.setItem=Storage.prototype._set;true");
await evalJs("(()=>{const q=document.querySelector('#itemList .qty');q.value='2個';q.dispatchEvent(new Event('input'));return true})()");
check("保存成功で失敗の案内が消える", !(await evalJs("document.getElementById('bannerArea').textContent")).includes("保存に失敗"));

// 4. 範囲外の年は受け付けない
await reset();
await evalJs("(()=>{const e=document.querySelector('#itemList .expiry');e.value='0099-01-01';e.dispatchEvent(new Event('change'));return true})()");
check("0099年は拒否して案内", (await evalJs("window.__alerts.join()")).includes("2000年"));
await nav(); await stub();
check("0099年の後もリストが読める", (await evalJs("document.querySelectorAll('.banner.error').length")) === 0);

// 5. 名前を1文字ずつ消しても元の名前に戻る
await reset();
await evalJs(`(()=>{const n=document.querySelector('#itemList .name');n.focus();n.dispatchEvent(new Event('focus'));
  n.value='飲';n.dispatchEvent(new Event('input'));n.value='';n.dispatchEvent(new Event('input'));n.dispatchEvent(new Event('blur'));return true})()`);
s = await stored();
check("全部消すと元の名前に戻る", s.items[0].name.startsWith("飲料水"));

// 6. 点検日時が不正なデータは読み込まない（元データは上書きしない）
await evalJs(`(()=>{const s=JSON.parse(localStorage.getItem(${KEY}));s.lastInspectionAt='garbage';localStorage.setItem(${KEY},JSON.stringify(s));return true})()`);
await nav(); await stub();
check("不正な点検日時は形式エラー", (await evalJs("document.getElementById('bannerArea').textContent")).includes("形式"));

// 7. JSON復元で古い案内が消える・余分な項目は取り込まない
const backup = join(profile, "backup.json");
const good = { formatVersion: 1, items: [{ id: "__proto__", name: "復元品", qty: "", expiry: null, checked: false, extra: "x".repeat(100) }], lastInspectionAt: null };
writeFileSync(backup, JSON.stringify(good));
const doc = await send("DOM.getDocument");
const fileNode = await send("DOM.querySelector", { nodeId: doc.result.root.nodeId, selector: "#importFile" });
await send("DOM.setFileInputFiles", { nodeId: fileNode.result.nodeId, files: [backup] });
await sleep(500);
s = await stored();
check("IDが__proto__でも復元できる", s.items.length === 1 && s.items[0].id === "__proto__");
check("余分な項目は取り込まない", !("extra" in s.items[0]));
check("復元後は形式エラーの案内が消える", (await evalJs("document.querySelectorAll('.banner.error').length")) === 0);

// 8. 日付が変わったら期限表示を更新する
await reset();
const tomorrow = await evalJs("(()=>{const d=new Date();d.setDate(d.getDate()+1);return d.getFullYear()+'-'+String(d.getMonth()+1).padStart(2,'0')+'-'+String(d.getDate()).padStart(2,'0')})()");
await evalJs(`(()=>{const e=document.querySelector('#itemList .expiry');e.value='${tomorrow}';e.dispatchEvent(new Event('change'));return true})()`);
check("明日期限は残り1日", (await evalJs("document.querySelector('.expiry-status').textContent")).includes("残り1日"));
await evalJs("(()=>{const R=Date;window.Date=class extends R{constructor(...a){if(a.length){super(...a)}else{super(R.now()+2*86400000)}}static now(){return R.now()+2*86400000}};document.dispatchEvent(new Event('visibilitychange'));return true})()");
check("2日後に画面へ戻ると期限切れ表示", (await evalJs("document.querySelector('.expiry-status').textContent")).includes("期限切れ"));

// 9. 拡大禁止を外した
check("拡大禁止の設定がない", !(await evalJs("document.querySelector('meta[name=viewport]').content")).includes("maximum-scale"));

// ---- 2026-11-16 Codex実装後レビュー分 ----
// 10. 以前の版で保存できたデータ（長い名前・空の名前・1999年の期限・600件）も読める
await reset();
await evalJs(`(()=>{const items=[];for(let i=0;i<600;i++)items.push({id:'o'+i,name:i===0?'':(i===1?'長'.repeat(250):'品'+i),qty:'',expiry:i===2?'1999-12-31':null,checked:false});
  localStorage.setItem(${KEY},JSON.stringify({formatVersion:1,items,lastInspectionAt:null}));return true})()`);
await nav(); await stub();
check("以前の版のデータも読める", (await evalJs("document.querySelectorAll('#itemList .item').length")) === 600 && (await evalJs("document.querySelectorAll('.banner.error').length")) === 0);

// 11. 別の画面で保存データが壊された直後の点検完了は確定しない
await reset();
await evalJs("document.querySelector('#itemList .item input[type=checkbox]').click();true");
await evalJs(`localStorage.setItem(${KEY},'{broken');true`);
await evalJs("document.getElementById('finishBtn').click();true");
check("壊された直後の点検完了はチェックを維持", await evalJs("document.querySelector('#itemList .item input[type=checkbox]').checked"));
check("壊された直後の点検完了は未点検のまま", (await evalJs("document.getElementById('lastInspection').textContent")).includes("未点検"));
check("壊されたデータは上書きしない", (await evalJs(`localStorage.getItem(${KEY})`)) === "{broken");

// 12. 追加時に別の画面の変更とぶつかったら、入力内容を残す
await reset();
await evalJs("document.querySelector('#itemList .item input[type=checkbox]').click();true");
await evalJs(`(()=>{const s=JSON.parse(localStorage.getItem(${KEY}));s.items[1].name='別画面';localStorage.setItem(${KEY},JSON.stringify(s));return true})()`);
await evalJs("(()=>{const f=document.getElementById('addForm');f.elements.name.value='追加したい品';f.requestSubmit();return true})()");
check("競合時は追加フォームの入力を残す", (await evalJs("document.getElementById('addForm').elements.name.value")) === "追加したい品");

// 13. 保存を止めている間に別の画面で直されたら、再開ボタンで上書きしない
await evalJs(`localStorage.setItem(${KEY},'{broken');true`); await nav(); await stub();
const fixed = JSON.stringify({ formatVersion: 1, items: [{ id: "f1", name: "直した品", qty: "", expiry: null, checked: false }], lastInspectionAt: null });
await evalJs(`localStorage.setItem(${KEY},${JSON.stringify(fixed)});true`);
await evalJs("[...document.querySelectorAll('.banner button')].find(b=>b.textContent.includes('新規作成')).click();true");
check("再開ボタンで直されたデータを上書きしない", (await evalJs(`localStorage.getItem(${KEY})`)) === fixed);
check("直されたデータを表示", (await evalJs("document.querySelector('#itemList .name').value")) === "直した品");

// 14. 起動時に保存機能が使えなくても、復元に成功したら「保存されません」の案内を消す
await reset();
await evalJs("window.name='fail-get-once';true");
await nav(); await stub();
check("保存機能なしの案内を表示", (await evalJs("document.getElementById('bannerArea').textContent")).includes("使えない"));
await send("DOM.setFileInputFiles", { nodeId: (await send("DOM.querySelector", { nodeId: (await send("DOM.getDocument")).result.root.nodeId, selector: "#importFile" })).result.nodeId, files: [backup] });
await sleep(500);
check("復元後は保存機能なしの案内が消える", !(await evalJs("document.getElementById('bannerArea').textContent")).includes("使えない"));
await evalJs("window.name='';true");

// 15. 1MBを超える大きなバックアップも復元できる（書き出せるものは復元できる）
await reset();
const bigItems = [];
for (let i = 0; i < 3000; i++) bigItems.push({ id: "b" + i, name: "品".repeat(200), qty: "", expiry: null, checked: false });
const bigFile = join(profile, "big.json");
writeFileSync(bigFile, JSON.stringify({ formatVersion: 1, items: bigItems, lastInspectionAt: null }, null, 2));
await send("DOM.setFileInputFiles", { nodeId: (await send("DOM.querySelector", { nodeId: (await send("DOM.getDocument")).result.root.nodeId, selector: "#importFile" })).result.nodeId, files: [bigFile] });
await sleep(1500);
check("1MB超のバックアップも復元できる", (await evalJs(`JSON.parse(localStorage.getItem(${KEY})).items.length`)) === 3000);
} finally {
  try { ws.close(); } catch {}
  edge.kill();
}
let fail = 0;
for (const r of results) { console.log(`${r.ok ? "OK  " : "FAIL"} ${r.name}${r.detail ? " : " + r.detail : ""}`); if (!r.ok) fail++; }
console.log(`\n${results.length - fail}/${results.length} passed`);
process.exit(fail ? 1 : 0);
