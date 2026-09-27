/* ============================================================
   JavaScript（動きの処理）ここから
   ------------------------------------------------------------
   おおまかな構成（上から順）：
     1. 保存の仕組み（IndexedDBという、端末内にデータを残す機能）
     2. 間隔反復（ライトナー方式）の計算 … 暗記アプリの中核ロジック
     3. 画面のあちこちで使う共通の小道具（$、シャッフルなど）
     4. 画面切り替え（ホーム／クイズ／図鑑／詳細／追加／設定）
     5. 各画面ごとの「表示を作る処理」と「ボタンが押されたときの処理」
     6. 写真の読み込み・縮小・保存
     7. 起動時に一度だけ実行する初期化処理
   ============================================================ */
"use strict"; // 書き間違い（未定義の変数への代入など）をエラーとして検出しやすくする宣言

/* =========================================================
   保存（IndexedDB）
   ------------------------------------------------------------
   花のデータ（名前・写真・記憶レベルなど）は、ブラウザの中にある
   「IndexedDB」という保管庫にしまう。サーバーには一切送らないので、
   ネットが無くても使え、他人から見られることもない。
   ここでは「flowers」という名前の保管箱を1つ作り、
   花1件＝1つのレコードとして出し入れする。
   ========================================================= */
const DB_NAME = "hana-quiz", STORE = "flowers";
let idb = null;       // IndexedDBが使えたときは、その接続をここに保持する
let memory = [];      // IndexedDBが使えない場合の代わりの置き場（画面を閉じると消える）

// 保管庫を開く（無ければ新しく作る）。使えない環境ではnullを返す
function openDB(){
  return new Promise((resolve)=>{
    let req;
    try{ req = indexedDB.open(DB_NAME, 1); }catch(e){ return resolve(null); }
    req.onupgradeneeded = ()=>{ // 初回だけ呼ばれ、保管箱(flowers)を用意する
      const d = req.result;
      if(!d.objectStoreNames.contains(STORE)) d.createObjectStore(STORE, {keyPath:"id"});
    };
    req.onsuccess = ()=>resolve(req.result);
    req.onerror = ()=>resolve(null);
    setTimeout(()=>resolve(req.result || null), 4000); // 4秒待っても開けなければ諦める
  });
}
function tx(mode){ return idb.transaction(STORE, mode).objectStore(STORE); } // 読み書き用の窓口を取得

// 登録済みの花を全件取り出す
async function dbAll(){
  if(!idb) return memory.slice();
  return new Promise((resolve)=>{
    try{
      const r = tx("readonly").getAll();
      r.onsuccess = ()=>resolve(r.result || []);
      r.onerror = ()=>resolve([]);
    }catch(e){ resolve([]); }
  });
}
// 花を1件、新規登録または上書き保存する
async function dbPut(rec){
  if(!idb){
    const i = memory.findIndex(f=>f.id===rec.id);
    if(i<0) memory.push(rec); else memory[i]=rec;
    return true;
  }
  return new Promise((resolve)=>{
    try{
      const r = tx("readwrite").put(rec);
      r.onsuccess = ()=>resolve(true);
      r.onerror = ()=>resolve(false);
    }catch(e){ resolve(false); }
  });
}
// 花を1件削除する
async function dbDel(id){
  if(!idb){ memory = memory.filter(f=>f.id!==id); return true; }
  return new Promise((resolve)=>{
    try{
      const r = tx("readwrite").delete(id);
      r.onsuccess = ()=>resolve(true);
      r.onerror = ()=>resolve(false);
    }catch(e){ resolve(false); }
  });
}

/* 出題数・出題モードなどの「設定」は、もっと軽い localStorage に保存する
   （こちらが使えない場合でも、初期値のままアプリは動く） */
const DEFAULTS = {count:10, mode:"ox", timer:0, theme:"auto"};
let settings = Object.assign({}, DEFAULTS);
function loadSettings(){ // 起動時に、前回保存した設定を読み込む
  try{
    const raw = localStorage.getItem("hana-settings");
    if(raw) settings = Object.assign({}, DEFAULTS, JSON.parse(raw));
  }catch(e){}
}
function saveSettings(){ // 設定が変わるたびに保存し直す
  try{ localStorage.setItem("hana-settings", JSON.stringify(settings)); }catch(e){}
}

/* =========================================================
   間隔反復（ライトナー方式） — このアプリの「暗記のコア」部分
   ------------------------------------------------------------
   花ごとに「箱番号（box）」という記憶レベル（1〜6）を持たせる。
   正解するたびに箱番号が1つ上がり、次に出題するまでの間隔
   （INTERVAL_DAYS）がどんどん延びていく。間違えると箱番号は1に
   戻り、また明日から出直しになる。
   こうすることで「覚えている花」は出題頻度が下がり、
   「まだ覚えていない花」だけが繰り返し出てくるようになる。
   ========================================================= */
const MAX_BOX = 6; // 箱番号の最大値（6段階）
const INTERVAL_DAYS = {1:0, 2:1, 3:3, 4:7, 5:16, 6:35}; // 箱番号ごとの「次の出題までの日数」
const DAY = 86400000; // 1日＝ミリ秒換算（24×60×60×1000）

// 記憶レベルを「●●●○○○」のような点の並びで表す文字列を作る
function levelLabel(box){
  const filled = "●".repeat(Math.max(0, box-1));
  const empty = "○".repeat(MAX_BOX-1-Math.max(0, box-1));
  return filled + empty;
}
// この花が「もう復習してよい時期」になっているか（出題予定日を過ぎたか）
function isDue(f){ return (f.due || 0) <= Date.now(); }
// 「だいたい覚えた」と見なす基準（箱番号5以上）
function isMastered(f){ return (f.box || 1) >= 5; }

// 1問の採点結果を花のデータに反映し、次の出題日を計算し直す
function grade(f, correct){
  f.seen = (f.seen||0) + 1;
  if(correct){
    f.correct = (f.correct||0) + 1;
    f.box = Math.min(MAX_BOX, (f.box||1) + 1); // 正解 → 箱を1つ進める（最大6まで）
  }else{
    f.wrong = (f.wrong||0) + 1;
    f.box = 1; // 不正解 → 箱番号を最初に戻す
  }
  f.due = Date.now() + INTERVAL_DAYS[f.box] * DAY; // 新しい箱番号にもとづき、次の出題予定日を決める
  f.last = Date.now();
  dbPut(f); // 変更を保管庫に書き戻す
}

/* =========================================================
   アプリ全体で共有する状態（変数）
   ========================================================= */
let flowers = [];        // 登録されている花の全データ（起動時にIndexedDBから読み込む）
let session = null;      // 今まさに出題中のクイズの進行状況（未出題ならnull）
let detailId = null;     // 詳細画面で今開いている花のid
let queue = [];          // 追加画面で「これから登録する」写真のグループ（まだ保存前）
let timerHandle = null, timeLeft = 0; // 出題タイマー（setIntervalのID／残り秒数）

const $ = (id)=>document.getElementById(id); // document.getElementById の短縮形。以下 $("xxx") で要素を取得する
const esc = (s)=>String(s==null?"":s);

function uid(){ return Date.now().toString(36) + Math.random().toString(36).slice(2,8); } // 花や写真グループにつける、重複しないID
// 配列の並び順をランダムに入れ替える（Fisher–Yatesアルゴリズム）
function shuffle(a){
  const r = a.slice();
  for(let i=r.length-1;i>0;i--){ const j = Math.floor(Math.random()*(i+1)); [r[i],r[j]]=[r[j],r[i]]; }
  return r;
}
function withPhotos(){ return flowers.filter(f=>f.photos && f.photos.length); } // 写真が1枚もない花は出題対象から除く

// 画面下に「保存しました」のような短い通知を一瞬だけ表示する
function toast(msg){
  const el = document.createElement("div");
  el.className = "toast";
  el.textContent = msg;
  document.body.appendChild(el);
  setTimeout(()=>el.remove(), 2600); // 2.6秒後に自動で消す
}

/* =========================================================
   画面切り替え
   ------------------------------------------------------------
   show("quiz") のように画面名を渡すと、id="s-quiz" の <section>
   にだけ "on" クラスを付けて表示し、他はすべて隠す。
   ========================================================= */
function show(name){
  document.querySelectorAll(".screen").forEach(s=>s.classList.remove("on")); // 一旦すべて隠す
  const el = $("s-" + name);
  if(el) el.classList.add("on"); // 目的の画面だけ表示する
  // 下のタブ（学習／図鑑／設定）のうち、今の画面に対応するものをハイライトする
  document.querySelectorAll("nav button").forEach(b=>{
    const active = (b.dataset.go === name) ||
      (name==="detail" && b.dataset.go==="lib") ||   // 詳細画面は「図鑑」タブの続き扱い
      (name==="add" && b.dataset.go==="lib") ||      // 追加画面も同様
      ((name==="quiz"||name==="result") && b.dataset.go==="home"); // クイズ中・結果は「学習」タブ扱い
    if(active) b.setAttribute("aria-current","page"); else b.removeAttribute("aria-current");
  });
  const main = document.querySelector("main");
  if(main) main.scrollTop = 0; // 画面が切り替わったらスクロール位置を上に戻す
  if(name !== "quiz") stopTimer(); // クイズ画面から離れたら、動いていたタイマーを止める
}
// 下のタブが押されたら、そのタブ用の「表示を作る処理」を呼んでから画面を切り替える
document.querySelectorAll("nav button").forEach(b=>{
  b.addEventListener("click", ()=>{
    const go = b.dataset.go;
    if(go==="home") renderHome();
    if(go==="lib") renderLibrary();
    if(go==="set") renderSettings();
    show(go);
  });
});

/* =========================================================
   ホーム画面の表示を作る
   ========================================================= */
function renderHome(){
  const pool = withPhotos();              // 出題できる花（写真がある花）だけを対象にする
  const due = pool.filter(isDue);         // その中で「今日もう復習してよい」花
  const mastered = pool.filter(isMastered); // その中で「だいたい覚えた」花

  $("tTotal").textContent = pool.length;
  $("tDue").textContent = due.length;
  $("tMaster").textContent = mastered.length;

  const lede = $("homeLede");
  if(pool.length === 0){
    lede.innerHTML = "まずは覚えたい花の<br>写真を登録しましょう。";
  }else if(due.length === 0){
    lede.innerHTML = "今日の復習は終わりました。<br><small>また時間をおくと出題されます。</small>";
  }else{
    lede.innerHTML = "今日は<b>" + due.length + "</b>種の<br>花を復習できます。";
  }

  $("startBtn").disabled = pool.length === 0 || due.length === 0;
  $("startBtn").textContent = due.length ? "復習をはじめる（" + Math.min(due.length, settings.count) + "問）" : "今日の復習は完了";
  $("startAllBtn").hidden = pool.length === 0;

  $("homeEmpty").innerHTML = pool.length ? "" :
    '<div class="empty"><b>使いはじめかた</b>' +
    '1. 下の「図鑑」を開いて「＋ 追加」<br>' +
    '2. 覚えたい花の写真をまとめて選ぶ<br>' +
    '3. 名前を確かめて登録<br>' +
    '写真が2種類以上そろうと、まぎらわしい名前を混ぜた○×問題が作られます。</div>';

  // 「まちがえやすい花」＝間違えた回数が多く、正解が少ない順に、上位5件を選ぶ
  const weak = pool.filter(f=>(f.wrong||0) > 0)
    .sort((a,b)=>((b.wrong||0)-(b.correct||0)) - ((a.wrong||0)-(a.correct||0)))
    .slice(0,5);
  $("weakHead").hidden = weak.length === 0;
  $("weakList").innerHTML = weak.map(f=>
    '<li data-id="'+f.id+'"><img src="'+f.photos[0]+'" alt=""><span class="nm">'+escapeHTML(f.name)+
    '</span><span class="rt">○'+(f.correct||0)+' / ×'+(f.wrong||0)+'</span></li>'
  ).join("");
}
// 花の名前などを画面に差し込む前に、HTMLとして特別な意味を持つ文字（< & " など）を
// 無害な表記に変換する。花の名前に記号が含まれていても表示が崩れないようにするための処理
function escapeHTML(s){
  return String(s==null?"":s).replace(/[&<>"']/g, c=>({
    "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"
  }[c]));
}
// 「まちがえやすい花」一覧の項目をタップしたら、その花の詳細画面を開く
$("weakList").addEventListener("click", e=>{
  const li = e.target.closest("li[data-id]");
  if(li) openDetail(li.dataset.id);
});
// 結果画面の「今回まちがえた花」一覧も同様
$("missList").addEventListener("click", e=>{
  const li = e.target.closest("li[data-id]");
  if(li) openDetail(li.dataset.id);
});

/* =========================================================
   出題づくり
   ------------------------------------------------------------
   1問ぶんのデータ（写真・問題文・正解）を組み立てる部分。
   ○×問題では、あえて「別の登録済みの花の名前」を紛れ込ませることで
   紛らわしい名前を見分ける練習になるようにしている。
   ========================================================= */

// 対象の花以外から、名前が重複しない花を1つランダムに選び、その名前を返す（＝ひっかけの名前）
function distractor(target, pool){
  const others = pool.filter(f=>f.id !== target.id && f.name !== target.name);
  if(others.length) return others[Math.floor(Math.random()*others.length)].name;
  return null; // 登録が1種類しかない場合は選べないのでnull
}

// 花fについて、1問ぶんの出題データを作る
function makeQuestion(f, pool){
  const photo = f.photos[Math.floor(Math.random()*f.photos.length)]; // その花の写真からランダムに1枚選ぶ
  // 設定が「○×と4択」で、花が4種類以上登録されていれば、35%の確率で4択問題にする
  const useChoice = settings.mode === "mix" && pool.length >= 4 && Math.random() < 0.35;

  if(useChoice){
    // 4択：正解の名前＋他の花から3つの名前をランダムに選び、並び順もシャッフルする
    const names = shuffle(pool.filter(x=>x.name !== f.name).map(x=>x.name));
    const opts = shuffle([f.name].concat(names.slice(0,3)));
    return {kind:"choice", flowerId:f.id, photo, options:opts, correctName:f.name};
  }
  // ○×：半分の確率で正しい名前、半分の確率で別の花の名前（ひっかけ）を問題文に使う
  const other = distractor(f, pool);
  const truth = other === null ? true : Math.random() < 0.5;
  return {kind:"ox", flowerId:f.id, photo, claimName: truth ? f.name : other, truth};
}

// 1回の学習セッションぶんの問題リストを作る
// onlyDue=true：今日出題してよい花だけを使う（ホームの「学習をはじめる」）
// onlyDue=false：出題予定日を過ぎていない花も足して、設定の問題数を満たす（「ぜんぶから出題する」）
function buildSession(onlyDue){
  const pool = withPhotos();
  if(pool.length === 0) return null;

  let picks = shuffle(pool.filter(isDue));
  if(!onlyDue && picks.length < settings.count){
    // 足りない分は、記憶レベルが低い（＝あまり覚えていない）花を優先して補充する
    const rest = shuffle(pool.filter(f=>!isDue(f))).sort((a,b)=>(a.box||1)-(b.box||1));
    picks = picks.concat(rest);
  }
  picks = picks.slice(0, settings.count); // 設定した問題数までに切り詰める
  if(picks.length === 0) return null;

  return {
    items: picks.map(f=>makeQuestion(f, pool)), // 選ばれた花それぞれについて問題を1つずつ作る
    at:0,                 // 今何問目か（0から数える）
    correct:0,             // ここまでの正解数
    total:picks.length,
    missed:[],             // このセッション中に一度でも間違えた花のid一覧
    requeued:{}            // 間違えた花をもう一度出題ずみか（1回だけ再出題するための目印）
  };
}
function startSession(onlyDue){
  const s = buildSession(onlyDue);
  if(!s){ toast("出題できる花がありません。まず写真を登録してください。"); return; }
  session = s;
  show("quiz");
  renderQuestion();
}
$("startBtn").addEventListener("click", ()=>startSession(true));
$("startAllBtn").addEventListener("click", ()=>startSession(false));
$("quitBtn").addEventListener("click", ()=>{ session=null; renderHome(); show("home"); });

/* =========================================================
   クイズ画面（出題〜回答受付）
   ========================================================= */
// 今の問題（session.items[session.at]）を画面に表示する
function renderQuestion(){
  const q = session.items[session.at];
  $("qCount").textContent = (session.at + 1) + " / " + session.items.length + " 問";
  $("qBar").style.width = (session.at / session.items.length * 100) + "%"; // 進捗バーの幅を更新
  $("qPhoto").src = q.photo;
  $("qVerdict").className = "verdict"; // 前の問題の⭕❌演出を消す
  $("qVerdict").innerHTML = "";
  $("qAsk").hidden = false;   // 問題側（○×ボタン or 選択肢）を表示
  $("qAnswer").hidden = true; // 解説側はまだ隠す

  if(q.kind === "ox"){
    $("qClaim").innerHTML = "この花は<em>" + escapeHTML(q.claimName) + "</em>である。";
    $("qClaim").hidden = false;
    $("qOx").hidden = false;
    $("qChoices").hidden = true;
  }else{ // 4択（choice）モード
    $("qClaim").textContent = "この花の名前は？";
    $("qClaim").hidden = false;
    $("qOx").hidden = true;
    const c = $("qChoices");
    c.hidden = false;
    c.innerHTML = q.options.map(n=>'<button data-name="'+escapeHTML(n)+'">'+escapeHTML(n)+'</button>').join("");
  }
  startTimer();
}
// 4択の選択肢がクリックされたら、押した名前と正解名を比べて採点する
$("qChoices").addEventListener("click", e=>{
  const b = e.target.closest("button[data-name]");
  if(!b) return;
  const q = session.items[session.at];
  respond(b.dataset.name === q.correctName, false);
});
// ○×ボタン：⭕を押したら「claimNameは正しい(truth===true)」かどうかで正誤判定
$("btnYes").addEventListener("click", ()=>{
  const q = session.items[session.at];
  respond(q.truth === true, false);
});
$("btnNo").addEventListener("click", ()=>{
  const q = session.items[session.at];
  respond(q.truth === false, false);
});

// 制限時間タイマーを開始する。設定で「なし」なら何もしない
function startTimer(){
  stopTimer();
  if(!settings.timer){ $("qTimer").textContent = ""; return; }
  timeLeft = settings.timer;
  $("qTimer").textContent = "⏱ " + timeLeft + "秒";
  timerHandle = setInterval(()=>{
    timeLeft--;
    $("qTimer").textContent = "⏱ " + Math.max(0,timeLeft) + "秒";
    if(timeLeft <= 0){ stopTimer(); respond(false, true); } // 時間切れは不正解として扱う
  }, 1000);
}
function stopTimer(){
  if(timerHandle){ clearInterval(timerHandle); timerHandle = null; }
}

// 1問に回答したときの共通処理（○×・4択・時間切れ、どこから呼ばれても通る）
function respond(correct, timedOut){
  stopTimer();
  const q = session.items[session.at];
  const f = flowers.find(x=>x.id === q.flowerId);
  if(!f) return;

  grade(f, correct); // ← ここで記憶レベル(box)と次の出題日(due)が更新され、保存される
  if(correct) session.correct++;
  else if(!session.missed.includes(f.id)) session.missed.push(f.id);

  // 写真の上に⭕／❌／⏱の演出を出す
  const v = $("qVerdict");
  v.className = "verdict on " + (correct ? "ok" : "ng");
  v.innerHTML = correct ? "⭕<small>せいかい</small>"
    : (timedOut ? "⏱<small>じかんぎれ</small>" : "❌<small>ちがいます</small>");

  // 解説欄に、正しい名前・別名・メモ・記憶レベルを表示する
  $("aName").textContent = f.name;
  $("aAlias").textContent = f.alias ? f.alias : "";
  $("aAlias").hidden = !f.alias;
  $("aMemo").textContent = f.memo ? f.memo : "（メモは図鑑から書き足せます）";
  $("aLevel").textContent = "記憶レベル " + levelLabel(f.box||1) + "　次の出題：" + nextText(f);

  $("qAsk").hidden = true;
  $("qAnswer").hidden = false;

  // 間違えた花は、このセッションの終わりに追加してもう一度出題する（1回だけ）
  if(!correct && !session.requeued[f.id]){
    session.requeued[f.id] = true;
    session.items.push(makeQuestion(f, withPhotos()));
  }
  const last = session.at >= session.items.length - 1;
  $("nextBtn").textContent = last ? "結果を見る" : "次の問題へ";
}
// 「次の出題：3日後」のような文言を作る
function nextText(f){
  const d = INTERVAL_DAYS[f.box||1];
  return d === 0 ? "すぐ" : d + "日後";
}
// 「次の問題へ」ボタン：最後の問題まで来ていれば結果画面へ、そうでなければ次を表示
$("nextBtn").addEventListener("click", ()=>{
  session.at++;
  if(session.at < session.items.length) renderQuestion();
  else finishSession();
});

// 全問終了時の処理：成績を集計して結果画面を表示する
function finishSession(){
  stopTimer();
  const asked = session.items.length;
  $("fScore").innerHTML = session.correct + '<small> / ' + asked + ' 問</small>';
  const rate = asked ? session.correct / asked : 0;
  $("fMsg").textContent =
    rate === 1 ? "全問正解です。次の復習日まで少し間があきます。" :
    rate >= .7 ? "よく覚えています。まちがえた花は近いうちにまた出ます。" :
                 "まちがえた花は明日また出題されます。くりかえすほど間隔が延びます。";

  const missed = session.missed.map(id=>flowers.find(f=>f.id===id)).filter(Boolean);
  $("missHead").hidden = missed.length === 0;
  $("missList").innerHTML = missed.map(f=>
    '<li data-id="'+f.id+'"><img src="'+f.photos[0]+'" alt=""><span class="nm">'+escapeHTML(f.name)+
    '</span><span class="rt">'+levelLabel(f.box||1)+'</span></li>').join("");

  session = null; // セッション終了。ホームに戻るとリセットされた状態から始まる
  show("result");
}
$("againBtn").addEventListener("click", ()=>startSession(false)); // 結果画面から、もう一度出題し直す
$("homeBtn").addEventListener("click", ()=>{ renderHome(); show("home"); });

/* =========================================================
   図鑑（登録済みの花の一覧）
   ========================================================= */
// 検索欄の文字に応じて花を絞り込み、五十音順に並べてタイル表示を作る
function renderLibrary(){
  const q = $("search").value.trim();
  const list = flowers
    .filter(f=>!q || f.name.includes(q) || (f.alias||"").includes(q))
    .sort((a,b)=>a.name.localeCompare(b.name,"ja"));

  $("grid").innerHTML = list.map(f=>
    '<button class="tile" data-id="'+f.id+'">' +
    (f.photos && f.photos.length ? '<img src="'+f.photos[0]+'" alt="">' : '<img alt="">') +
    '<span class="cap"><span class="nm">'+escapeHTML(f.name)+'</span>' +
    '<span class="lv">'+levelLabel(f.box||1)+'</span></span></button>'
  ).join("");

  $("libEmpty").innerHTML = flowers.length ? "" :
    '<div class="empty"><b>まだ何も登録されていません</b>' +
    '「＋ 追加」から花の写真を選んでください。1種類につき何枚でも登録できます。' +
    '角度や咲き方のちがう写真を入れておくと、実物を見たときに気づけるようになります。</div>';
}
$("search").addEventListener("input", renderLibrary); // 入力のたびに絞り込み直す
// タイルをタップしたら、そのidの花の詳細画面を開く
$("grid").addEventListener("click", e=>{
  const b = e.target.closest(".tile[data-id]");
  if(b) openDetail(b.dataset.id);
});
$("toAddBtn").addEventListener("click", ()=>{ queue = []; renderQueue(); show("add"); }); // 追加画面へ（登録待ちリストは空から）
$("aBack").addEventListener("click", ()=>{ renderLibrary(); show("lib"); });

/* =========================================================
   詳細（1件の花を編集する画面）
   ========================================================= */
// idで指定した花の情報を入力欄に流し込み、詳細画面を開く
function openDetail(id){
  const f = flowers.find(x=>x.id === id);
  if(!f) return;
  detailId = id;
  $("dName").value = f.name || "";
  $("dAlias").value = f.alias || "";
  $("dMemo").value = f.memo || "";
  $("dPhotos").innerHTML = (f.photos||[]).map((p,i)=>
    '<figure><img src="'+p+'" alt=""><button data-i="'+i+'" aria-label="この写真を削除">✕</button></figure>'
  ).join("") || '<p class="note">写真がありません。「写真を足す」から登録してください。</p>';
  const total = (f.correct||0) + (f.wrong||0);
  $("dStats").textContent =
    "記憶レベル " + levelLabel(f.box||1) +
    "　正解 " + (f.correct||0) + " / 出題 " + total +
    (f.due ? "　次の出題：" + fmtDate(f.due) : "");
  show("detail");
}
// 出題予定日を「いつでも」または「◯月◯日」の表示用文字列にする
function fmtDate(ts){
  if(ts <= Date.now()) return "いつでも";
  const d = new Date(ts);
  return (d.getMonth()+1) + "月" + d.getDate() + "日";
}
$("dBack").addEventListener("click", ()=>{ renderLibrary(); show("lib"); });
// 写真の✕ボタン：その1枚だけ配列から取り除いて保存し直す
$("dPhotos").addEventListener("click", async e=>{
  const b = e.target.closest("button[data-i]");
  if(!b) return;
  const f = flowers.find(x=>x.id === detailId);
  if(!f) return;
  f.photos.splice(Number(b.dataset.i), 1);
  await dbPut(f);
  openDetail(detailId); // 削除後の状態で画面を作り直す
});
// 「保存する」：入力欄の内容を花のデータに反映する
$("dSave").addEventListener("click", async ()=>{
  const f = flowers.find(x=>x.id === detailId);
  if(!f) return;
  const name = $("dName").value.trim();
  if(!name){ toast("花の名前を入れてください。"); return; }
  f.name = name;
  f.alias = $("dAlias").value.trim();
  f.memo = $("dMemo").value;
  await dbPut(f);
  toast("保存しました");
  renderLibrary();
  show("lib");
});
// 「学習の記録をリセット」：記憶レベルと正誤カウントを初期状態に戻す
$("dReset").addEventListener("click", async ()=>{
  const f = flowers.find(x=>x.id === detailId);
  if(!f) return;
  f.box = 1; f.due = 0; f.correct = 0; f.wrong = 0; f.seen = 0;
  await dbPut(f);
  openDetail(detailId);
  toast("学習の記録をリセットしました");
});
// 「この花を削除」：確認してから、保管庫と画面上の一覧の両方から取り除く
$("dDelete").addEventListener("click", async ()=>{
  const f = flowers.find(x=>x.id === detailId);
  if(!f) return;
  if(!confirm("「" + f.name + "」を写真ごと削除します。よろしいですか？")) return;
  await dbDel(f.id);
  flowers = flowers.filter(x=>x.id !== f.id);
  renderLibrary();
  show("lib");
  toast("削除しました");
});
// 「写真を足す」：詳細画面から直接ファイル選択を開き、選んだ写真をこの花に追加する
$("dAddPhoto").addEventListener("click", ()=>{
  const inp = document.createElement("input");
  inp.type = "file"; inp.accept = "image/*"; inp.multiple = true;
  inp.addEventListener("change", async ()=>{
    const f = flowers.find(x=>x.id === detailId);
    if(!f) return;
    toast("写真を読み込んでいます…");
    const res = await readFiles(Array.from(inp.files||[]));
    f.photos = (f.photos||[]).concat(res.items.map(x=>x.data));
    await dbPut(f);
    openDetail(detailId);
    toast(res.items.length + "枚を追加しました" + (res.failed ? "（" + res.failed + "枚は読めませんでした）" : ""));
  });
  inp.click();
});

/* =========================================================
   写真の読み込み・縮小・ファイル名からの推定
   ------------------------------------------------------------
   スマホの写真はそのままだと数MBあり、たくさん登録すると保存が
   重くなるため、ここで長辺1280pxまで縮小してから保存している。
   また、ファイル名（例：「チューリップ_1.jpg」）から末尾の連番を
   取り除き、花の名前の候補（base）を推測している。
   ========================================================= */

// ファイルを、ブラウザが扱える画像（Imageオブジェクト）として読み込む
function loadImage(file){
  return new Promise((resolve, reject)=>{
    const url = URL.createObjectURL(file); // ファイルを一時的なURLとして扱えるようにする
    const img = new Image();
    img.onload = ()=>{ URL.revokeObjectURL(url); resolve(img); };
    img.onerror = ()=>{ URL.revokeObjectURL(url); reject(new Error("decode")); };
    img.src = url;
  });
}
// 画像を指定サイズ以下に縮小し、保存用の文字列（DataURL）に変換する
async function toDataURL(file, max=1280, quality=0.82){
  const img = await loadImage(file);
  const scale = Math.min(1, max / Math.max(img.naturalWidth, img.naturalHeight)); // 大きすぎる場合だけ縮小
  const w = Math.max(1, Math.round(img.naturalWidth * scale));
  const h = Math.max(1, Math.round(img.naturalHeight * scale));
  const c = document.createElement("canvas"); // 見えないキャンバスに描き直すことでリサイズする
  c.width = w; c.height = h;
  const ctx = c.getContext("2d");
  ctx.fillStyle = "#fff";
  ctx.fillRect(0,0,w,h);
  ctx.drawImage(img, 0, 0, w, h);
  return c.toDataURL("image/jpeg", quality); // JPEGとして書き出す（qualityで画質と容量のバランスを取る）
}
// ファイル名から、末尾の連番やカメラの自動採番（IMG_1234など）を取り除き、花の名前の候補にする
// 例：「チューリップ_1.jpg」「チューリップ (2).jpg」→ どちらも「チューリップ」
function baseName(filename){
  let n = filename.replace(/\.[^.]+$/, "");                                   // 拡張子を除く
  n = n.replace(/[\s_\-–—]*[（(\[]?\s*\d{1,3}\s*[)）\]]?$/, "");              // 末尾の「_1」「(2)」などの連番を除く
  n = n.replace(/^(IMG|DSC|PXL|P)[\s_\-]*\d*$/i, "");                         // カメラが自動で付けた「IMG_1234」のような名前は空にする
  return n.trim();
}
// 選ばれた複数のファイルをまとめて処理する（画像でないものは失敗として数える）
async function readFiles(files){
  const items = [], seen = [];
  let failed = 0;
  for(const file of files){
    if(!/^image\//.test(file.type) && !/\.(jpe?g|png|webp|gif|heic|heif)$/i.test(file.name)){ failed++; continue; }
    try{
      const data = await toDataURL(file);
      items.push({data, base: baseName(file.name)});
      seen.push(file.name);
    }catch(e){ failed++; }
  }
  return {items, failed};
}

/* =========================================================
   追加画面（写真を選んでから登録するまで）
   ========================================================= */
// ファイル選択（複数可）が完了したときの処理
$("files").addEventListener("change", async e=>{
  const files = Array.from(e.target.files || []);
  if(!files.length) return;
  toast("写真を読み込んでいます…");
  const res = await readFiles(files); // 全ファイルを縮小しつつ読み込み、ファイル名の推定名も得る

  e.target.value = ""; // 同じファイルを選び直したときにも change イベントが発火するようにリセット

  // 同じ推定名（base）を持つ写真どうしをグループ化する
  // → 「チューリップ_1.jpg」と「チューリップ_2.jpg」が1つの花としてまとまる
  const groups = new Map();
  for(const it of res.items){
    const key = it.base || "（名前未設定）";
    if(!groups.has(key)) groups.set(key, {name: it.base, photos: []});
    groups.get(key).photos.push(it.data);
  }
  // すでに登録待ちリスト(queue)に同名のグループがあれば写真を合流させ、なければ新規に追加する
  for(const g of groups.values()){
    const exist = queue.find(q=>q.name && g.name && q.name === g.name);
    if(exist) exist.photos = exist.photos.concat(g.photos);
    else queue.push({key: uid(), name: g.name, photos: g.photos});
  }
  renderQueue();
  if(res.failed) toast(res.failed + "枚は読み込めませんでした");
});

// 登録待ちリスト(queue)の中身を、名前を編集できる形で一覧表示する
function renderQueue(){
  $("queue").innerHTML = queue.map(q=>
    '<li data-key="'+q.key+'"><img src="'+q.photos[0]+'" alt="">' +
    '<span class="fld"><input value="'+escapeHTML(q.name)+'" placeholder="花の名前を入力" data-key="'+q.key+'">' +
    '<span class="ct">写真 '+q.photos.length+'枚</span></span>' +
    '<button class="rm" data-rm="'+q.key+'" aria-label="取り消す">✕</button></li>'
  ).join("");
  $("queueActions").hidden = queue.length === 0;
}
// 登録待ちリストで名前欄を書き換えたら、その場でqueueのデータにも反映する
$("queue").addEventListener("input", e=>{
  const inp = e.target.closest("input[data-key]");
  if(!inp) return;
  const q = queue.find(x=>x.key === inp.dataset.key);
  if(q) q.name = inp.value;
});
// ✕ボタンで、そのグループを登録待ちリストから取り消す（まだ保存前なので消えるだけ）
$("queue").addEventListener("click", e=>{
  const b = e.target.closest("button[data-rm]");
  if(!b) return;
  queue = queue.filter(x=>x.key !== b.dataset.rm);
  renderQueue();
});
// 「この内容で登録する」：登録待ちリストの内容を、実際にflowers（保管庫）へ書き込む
$("saveQueue").addEventListener("click", async ()=>{
  const bad = queue.find(q=>!q.name.trim());
  if(bad){ toast("名前が空のものがあります。"); return; }
  let added = 0, merged = 0;
  for(const q of queue){
    const name = q.name.trim();
    const exist = flowers.find(f=>f.name === name); // 同じ名前の花がすでにあるか確認
    if(exist){
      // すでにある花なら、写真だけ追加する
      exist.photos = (exist.photos||[]).concat(q.photos);
      await dbPut(exist);
      merged++;
    }else{
      // 新しい花として、記憶レベルなどの初期値を持たせて登録する
      const rec = {
        id: uid(), name, alias:"", memo:"", photos: q.photos,
        box:1, due:0, correct:0, wrong:0, seen:0, created:Date.now()
      };
      flowers.push(rec);
      await dbPut(rec);
      added++;
    }
  }
  queue = [];
  renderQueue();
  renderLibrary();
  show("lib");
  toast(added + "種を登録" + (merged ? "、" + merged + "種に写真を追加" : "") + "しました");
});

/* =========================================================
   設定画面
   ========================================================= */
// 「5問／10問／20問」のような選択ボタン群を1つ作る共通部品
// el：ボタンを入れる場所、opts：選択肢一覧、current：今の設定値、onPick：選ばれたときの処理
function segment(el, opts, current, onPick){
  el.innerHTML = opts.map(o=>
    '<button data-v="'+o.v+'" aria-pressed="'+(String(o.v)===String(current))+'">'+o.l+'</button>'
  ).join("");
  el.onclick = (e)=>{
    const b = e.target.closest("button[data-v]");
    if(!b) return;
    onPick(b.dataset.v);
    saveSettings();     // 選んだ内容をすぐ保存する
    renderSettings();   // ボタンの見た目（選択中の表示）を更新するため作り直す
  };
}
// 設定画面のすべての選択肢グループを組み立てる
function renderSettings(){
  segment($("segCount"), [{v:5,l:"5問"},{v:10,l:"10問"},{v:20,l:"20問"}], settings.count, v=>settings.count = Number(v));
  segment($("segMode"), [{v:"ox",l:"○×だけ"},{v:"mix",l:"○×と4択"}], settings.mode, v=>settings.mode = v);
  segment($("segTimer"), [{v:0,l:"なし"},{v:15,l:"15秒"},{v:30,l:"30秒"}], settings.timer, v=>settings.timer = Number(v));
  segment($("segTheme"), [{v:"auto",l:"端末に合わせる"},{v:"light",l:"明るい"},{v:"dark",l:"暗い"}], settings.theme, v=>{
    settings.theme = v; applyTheme();
  });
  const photos = flowers.reduce((n,f)=>n + (f.photos?f.photos.length:0), 0);
  $("storeNote").textContent = idb
    ? "この端末のブラウザに保存しています（花 " + flowers.length + "種・写真 " + photos + "枚）。インターネットに送られることはありません。"
    : "この端末に保存できませんでした。画面を閉じると消えます。ブラウザのプライベートモードを解除すると保存できます。";
}
// 「画面の明るさ」設定を、実際にCSSの data-theme 属性へ反映する
// （CSS側の :root[data-theme="dark"] などが、この属性を見て配色を切り替える）
function applyTheme(){
  if(settings.theme === "auto") document.documentElement.removeAttribute("data-theme");
  else document.documentElement.setAttribute("data-theme", settings.theme);
}

/* ---- バックアップの書き出し・読み込み ----
   花のデータをまるごとJSON（テキスト）形式のファイルにして保存・復元する。
   機種変更や、別の端末にコピーしたいときに使う想定。 */
$("exportBtn").addEventListener("click", async ()=>{
  const payload = JSON.stringify({app:"hana-quiz", version:1, exported:Date.now(), flowers});
  const name = "hana-quiz-backup-" + new Date().toISOString().slice(0,10) + ".json";
  try{
    // このアプリを開いている環境がファイル保存に対応していれば、それを使って書き出す
    const downloads = window.claude && window.claude.use ? await window.claude.use("downloads") : null;
    if(downloads){
      await downloads.save({filename:name, data:payload});
      toast("バックアップを書き出しました");
      return;
    }
  }catch(e){}
  // ファイル保存に対応していない環境向けの代わりの手段：クリップボードにコピーする
  try{
    await navigator.clipboard.writeText(payload);
    toast("ファイルに保存できないため、内容をコピーしました");
  }catch(e){
    toast("この画面では書き出せませんでした");
  }
});
// バックアップファイルを選んで読み込む処理
$("importFile").addEventListener("change", async e=>{
  const file = (e.target.files || [])[0];
  e.target.value = "";
  if(!file) return;
  try{
    const text = await file.text();
    const data = JSON.parse(text);
    if(!data || !Array.isArray(data.flowers)) throw new Error("format"); // 想定した形式でなければエラーにする
    if(!confirm("バックアップから " + data.flowers.length + "種を読み込みます。同じ名前の花は写真がまとめられます。よろしいですか？")) return;
    for(const raw of data.flowers){
      if(!raw || !raw.name) continue;
      const exist = flowers.find(f=>f.name === raw.name);
      if(exist){
        // 同名の花がすでにあれば、まだ持っていない写真だけを追加する（重複を避ける）
        const have = new Set(exist.photos||[]);
        exist.photos = (exist.photos||[]).concat((raw.photos||[]).filter(p=>!have.has(p)));
        await dbPut(exist);
      }else{
        // 新しい花として、バックアップの内容（記憶レベルなども含めて）をそのまま登録する
        const rec = {
          id: uid(), name: raw.name, alias: raw.alias||"", memo: raw.memo||"",
          photos: raw.photos||[], box: raw.box||1, due: raw.due||0,
          correct: raw.correct||0, wrong: raw.wrong||0, seen: raw.seen||0, created: Date.now()
        };
        flowers.push(rec);
        await dbPut(rec);
      }
    }
    renderSettings();
    renderHome();
    toast("読み込みました");
  }catch(err){
    toast("このファイルは読み込めませんでした");
  }
});

/* =========================================================
   起動処理 — ページが開かれたときに一度だけ実行される
   ========================================================= */
(async function init(){
  loadSettings();       // 前回の設定（出題数・モードなど）を読み込む
  applyTheme();         // 明るさ設定を反映する
  idb = await openDB(); // 保管庫（IndexedDB）を開く
  flowers = await dbAll(); // 保存されている花のデータを全件読み込む
  flowers.forEach(f=>{ if(!f.photos) f.photos = []; }); // 古いデータ互換のため、photosが無ければ空配列にしておく
  renderHome();
  renderLibrary();
  renderSettings();
  $("modeHint").textContent = "";
})();
/* JavaScript（動きの処理）ここまで */
