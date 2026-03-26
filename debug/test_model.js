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
  var turn = parsed[0][0];

  console.log("=== TURN[3] (model response) ===");
  console.log("turn[3] type:", typeof turn[3], Array.isArray(turn[3]) ? "arr("+turn[3].length+")" : "");
  if (turn[3]) {
    console.log("turn[3][0] type:", typeof turn[3][0], Array.isArray(turn[3][0]) ? "arr("+turn[3][0].length+")" : "");
    if (turn[3][0]) {
      for (var i = 0; i < Math.min(turn[3][0].length, 5); i++) {
        var v = turn[3][0][i];
        var vt = typeof v;
        if (v === null) vt = "null";
        else if (Array.isArray(v)) vt = "arr(" + v.length + ")";
        console.log("turn[3][0]["+i+"]:", vt);
        if (typeof v === "string") console.log("  value:", v.slice(0,100));
        if (Array.isArray(v) && v.length > 0) {
          var first = v[0];
          if (typeof first === "string") console.log("  [0]:", first.slice(0,200));
          else if (Array.isArray(first)) console.log("  [0]: arr("+first.length+"), [0][0]:", typeof first[0] === "string" ? first[0].slice(0,200) : typeof first[0]);
        }
      }
    }
  }
});