/**
 * 生成单文件离线抽奖页：断网或服务器故障时，双击即可在本机浏览器继续抽奖。
 * 名单、奖项剩余数量在导出时固化；结果保存在浏览器 localStorage，可导出 CSV 事后补录。
 */
const esc = (s) =>
  String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

// 嵌入 <script> 时避免 </script> 与 U+2028/2029 截断
const embed = (v) =>
  JSON.stringify(v)
    .replace(/</g, '\\u003c')
    .replace(new RegExp(String.fromCharCode(0x2028), 'g'), '\\u2028')
    .replace(new RegExp(String.fromCharCode(0x2029), 'g'), '\\u2029');

export function renderOfflinePackage({ title, pool, prizes }) {
  const exportedAt = new Date().toLocaleString('zh-CN', { hour12: false });
  return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)} · 离线抽奖</title>
<style>
*{box-sizing:border-box}body{margin:0;min-height:100vh;font-family:system-ui,"PingFang SC","Microsoft YaHei",sans-serif;
background:radial-gradient(ellipse at top,#7a1020,#2a0408 70%);color:#fff;display:flex;flex-direction:column;align-items:center}
h1{margin:28px 0 4px;font-size:40px;letter-spacing:4px;color:#ffd77a}.tip{opacity:.7;font-size:14px}
.bar{margin:20px 0;display:flex;gap:12px;flex-wrap:wrap;justify-content:center;align-items:center}
select,input,button{font-size:18px;padding:8px 14px;border-radius:8px;border:0}
button{background:#ffd77a;color:#5a0a10;font-weight:700;cursor:pointer}button:disabled{opacity:.4;cursor:not-allowed}
#roll{font-size:72px;font-weight:800;min-height:110px;margin:24px 0;color:#ffe9b0;text-shadow:0 0 30px #ffb300}
#res{display:flex;flex-wrap:wrap;gap:12px;justify-content:center;max-width:1100px}
.card{background:rgba(255,255,255,.12);border:1px solid rgba(255,215,122,.5);border-radius:12px;padding:12px 20px;min-width:160px;text-align:center}
.card b{display:block;font-size:26px;color:#ffd77a}.card span{font-size:13px;opacity:.8}
table{margin:30px 0;border-collapse:collapse;font-size:14px;background:rgba(0,0,0,.25)}td,th{padding:6px 12px;border-bottom:1px solid rgba(255,255,255,.15)}
</style></head><body>
<h1>${esc(title)}</h1>
<div class="tip">离线模式 · 名单导出于 ${esc(exportedAt)} · 共 <span id="poolN"></span> 人可抽 · 空格键开始/停止</div>
<div class="bar"><select id="prize"></select><input id="count" type="number" min="1" value="1" style="width:90px">
<button id="go">开始</button><button id="csv">导出结果 CSV</button><button id="clear" style="background:#888;color:#fff">清空本机记录</button></div>
<div id="roll">准备就绪</div><div id="res"></div>
<table id="log"><thead><tr><th>时间</th><th>奖项</th><th>姓名</th><th>部门</th><th>手机</th></tr></thead><tbody></tbody></table>
<script>
(function(){
var POOL=${embed(pool)}, PRIZES=${embed(prizes)}, KEY='vl-offline-'+${embed(exportedAt)};
var state=JSON.parse(localStorage.getItem(KEY)||'{"records":[]}');
function $(id){return document.getElementById(id)}
function save(){localStorage.setItem(KEY,JSON.stringify(state))}
function rnd(n){var a=new Uint32Array(1),lim=Math.floor(4294967296/n)*n;do{crypto.getRandomValues(a)}while(a[0]>=lim);return a[0]%n}
function winnersSet(){var s={};state.records.forEach(function(r){s[r.idx]=1});return s}
function avail(){var w=winnersSet();return POOL.map(function(p,i){return i}).filter(function(i){return !w[i]})}
function left(pid){var p=PRIZES.filter(function(x){return x.id==pid})[0];return p.remaining-state.records.filter(function(r){return r.prizeId==pid}).length}
function text(el,t){el.textContent=t}
function renderPrizes(){var sel=$('prize'),cur=sel.value;sel.innerHTML='';PRIZES.forEach(function(p){var o=document.createElement('option');o.value=p.id;
text(o,p.name+'（剩 '+left(p.id)+'）');sel.appendChild(o)});if(cur)sel.value=cur;text($('poolN'),avail().length)}
function renderLog(){var tb=document.querySelector('#log tbody');tb.innerHTML='';state.records.slice().reverse().forEach(function(r){var tr=document.createElement('tr');
[r.time,r.prize,POOL[r.idx].name,POOL[r.idx].dept,POOL[r.idx].phone].forEach(function(v){var td=document.createElement('td');text(td,v||'');tr.appendChild(td)});tb.appendChild(tr)})}
var timer=null;
function start(){var a=avail();if(!a.length){alert('没有可抽的人了');return}if(left($('prize').value)<=0){alert('该奖项已抽完');return}
$('res').innerHTML='';text($('go'),'停止');timer=setInterval(function(){text($('roll'),POOL[a[rnd(a.length)]].name)},50)}
function stop(){clearInterval(timer);timer=null;text($('go'),'开始');var pid=$('prize').value,p=PRIZES.filter(function(x){return x.id==pid})[0];
var a=avail(),n=Math.min(parseInt($('count').value,10)||1,left(pid),a.length),now=new Date().toLocaleString('zh-CN',{hour12:false});
for(var i=0;i<n;i++){var j=i+rnd(a.length-i),t=a[i];a[i]=a[j];a[j]=t;state.records.push({idx:a[i],prizeId:p.id,prize:p.name,time:now});
var c=document.createElement('div');c.className='card';var b=document.createElement('b');text(b,POOL[a[i]].name);var s=document.createElement('span');
text(s,(POOL[a[i]].dept||'')+' '+POOL[a[i]].phone);c.appendChild(b);c.appendChild(s);$('res').appendChild(c)}
text($('roll'),p.name+' · '+n+' 人');save();renderPrizes();renderLog()}
$('go').onclick=function(){timer?stop():start()};
document.addEventListener('keydown',function(e){if(e.code==='Space'&&e.target.tagName!=='INPUT'){e.preventDefault();$('go').click()}});
$('csv').onclick=function(){var rows=[['时间','奖项','姓名','部门','手机(脱敏)']].concat(state.records.map(function(r){var p=POOL[r.idx];return[r.time,r.prize,p.name,p.dept,p.phone]}));
var csv='\\ufeff'+rows.map(function(r){return r.map(function(v){v=String(v||'');if(/^[=+\\-@]/.test(v))v="'"+v;return /[",\\n]/.test(v)?'"'+v.replace(/"/g,'""')+'"':v}).join(',')}).join('\\r\\n');
var a=document.createElement('a');a.href=URL.createObjectURL(new Blob([csv],{type:'text/csv'}));a.download='offline-winners.csv';a.click()};
$('clear').onclick=function(){if(prompt('输入「确认清空」以清除本机离线记录')==='确认清空'){state={records:[]};save();renderPrizes();renderLog();$('res').innerHTML=''}};
renderPrizes();renderLog();
})();
</script></body></html>`;
}
