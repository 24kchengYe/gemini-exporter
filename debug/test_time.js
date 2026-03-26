var A=document.documentElement.innerHTML.match(/"SNlM0e":"([^"]+)"/)[1];
var B=document.documentElement.innerHTML.match(/"cfb2h":"([^"]+)"/)[1];
fetch("https://gemini.google.com/_/BardChatUi/data/batchexecute?rpcids=hNvQHb&source-path=/app&hl=en&rt=c&bl="+B,{method:"POST",credentials:"include",headers:{"Content-Type":"application/x-www-form-urlencoded;charset=utf-8"},body:"at="+encodeURIComponent(A)+"&f.req="+encodeURIComponent(JSON.stringify([[["hNvQHb",JSON.stringify(["c_471c4c1dc69ed6ed",1000,null,1,[1],[4],null,1]),null,"generic"]]])) }).then(function(r){return r.text()}).then(function(t){
  var marker = '"wrb.fr","hNvQHb","';
  var idx = t.indexOf(marker);
  var bs = idx;
  while (bs > 0 && t[bs] !== "[") bs--;
  var gi = t.indexOf(',"generic"', idx + marker.length);
  var cb = t.indexOf("]", gi + 10);
  var arr = JSON.parse(t.substring(bs, cb + 1));
  var parsed = JSON.parse(arr[2]);
  var turn0 = parsed[0][0];

  // Look for numbers that could be timestamps (10-digit = seconds, 13-digit = ms)
  function findNumbers(obj, path, depth) {
    if (depth > 4) return;
    if (typeof obj === "number" && obj > 1600000000 && obj < 2000000000) {
      console.log(path + ": " + obj + " = " + new Date(obj * 1000).toISOString());
    }
    if (typeof obj === "number" && obj > 1600000000000 && obj < 2000000000000) {
      console.log(path + ": " + obj + " = " + new Date(obj).toISOString());
    }
    if (Array.isArray(obj)) {
      for (var i = 0; i < obj.length; i++) findNumbers(obj[i], path+"["+i+"]", depth+1);
    }
  }
  console.log("=== TIMESTAMPS IN FIRST TURN ===");
  findNumbers(turn0, "turn0", 0);

  // Also check last turn for comparison
  var lastTurn = parsed[0][parsed[0].length - 1];
  console.log("\n=== TIMESTAMPS IN LAST TURN ===");
  findNumbers(lastTurn, "lastTurn", 0);

  // Also check sidebar link text for reference
  var links = document.querySelectorAll('a[href*="/app/"]');
  console.log("\n=== FIRST 3 SIDEBAR LINKS ===");
  var count = 0;
  links.forEach(function(a) {
    if (count >= 3) return;
    var href = a.getAttribute("href");
    if (href && href.match(/\/app\/[a-f0-9]/) && !href.includes("SignOut")) {
      console.log("href:", href);
      console.log("  innerText:", (a.innerText||"").slice(0,60));
      console.log("  aria-label:", a.getAttribute("aria-label"));
      console.log("  textContent:", (a.textContent||"").slice(0,60));
      count++;
    }
  });
});