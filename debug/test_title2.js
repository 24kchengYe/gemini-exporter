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

  // Deep search for any string that looks like a title
  var turn0 = parsed[0][0];
  // Check turn0[0] deeply
  console.log("turn0[0]:", JSON.stringify(turn0[0]));
  console.log("turn0[1]:", JSON.stringify(turn0[1]));
  // The conversation ID pair is usually at turn0[0]
  // Look for strings in the first few turns
  function findStrings(obj, path, depth) {
    if (depth > 3) return;
    if (typeof obj === "string" && obj.length > 3 && obj.length < 200) {
      console.log(path + ":", obj);
    }
    if (Array.isArray(obj)) {
      for (var i = 0; i < Math.min(obj.length, 10); i++) {
        findStrings(obj[i], path + "[" + i + "]", depth + 1);
      }
    }
  }
  console.log("\n=== ALL STRINGS IN turn0 (depth 3) ===");
  findStrings(turn0, "turn0", 0);

  // Also check the user's first message as title fallback
  var userMsg = turn0[2] && turn0[2][0] && turn0[2][0][0];
  console.log("\nFirst user message:", userMsg && userMsg.slice(0, 100));
});