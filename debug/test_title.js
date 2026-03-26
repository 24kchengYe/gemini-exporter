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

  // Search for title in all positions
  console.log("=== SEARCHING FOR TITLE ===");
  for (var i = 0; i < Math.min(parsed.length, 10); i++) {
    var v = parsed[i];
    var type = typeof v;
    if (v === null) type = "null";
    else if (Array.isArray(v)) type = "array(" + v.length + ")";
    console.log("parsed[" + i + "]:", type, typeof v === "string" ? v.slice(0, 100) : "");
  }

  // Also check nested - title might be in parsed[0][0] metadata
  var turn0 = parsed[0] && parsed[0][0];
  if (turn0) {
    console.log("\n=== FIRST TURN STRUCTURE ===");
    for (var j = 0; j < Math.min(turn0.length, 8); j++) {
      var w = turn0[j];
      var wt = typeof w;
      if (w === null) wt = "null";
      else if (Array.isArray(w)) wt = "array(" + w.length + ")";
      console.log("turn0[" + j + "]:", wt, typeof w === "string" ? w.slice(0, 100) : "");
    }
  }

  // Check document title on page as fallback reference
  console.log("\ndocument.title:", document.title);
});