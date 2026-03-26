var A=document.documentElement.innerHTML.match(/"SNlM0e":"([^"]+)"/)[1];
var B=document.documentElement.innerHTML.match(/"cfb2h":"([^"]+)"/)[1];
fetch("https://gemini.google.com/_/BardChatUi/data/batchexecute?rpcids=hNvQHb&source-path=/app&hl=en&rt=c&bl="+B,{method:"POST",credentials:"include",headers:{"Content-Type":"application/x-www-form-urlencoded;charset=utf-8"},body:"at="+encodeURIComponent(A)+"&f.req="+encodeURIComponent(JSON.stringify([[["hNvQHb",JSON.stringify(["c_471c4c1dc69ed6ed",1000,null,1,[1],[4],null,1]),null,"generic"]]])) }).then(function(r){return r.text()}).then(function(t){
  var marker = '"wrb.fr","hNvQHb","';
  var idx = t.indexOf(marker);
  console.log("marker found at:", idx);
  if (idx < 0) { console.log("NO MARKER. first 500:", t.slice(0,500)); return; }

  // find outer [ before marker
  var bs = idx;
  while (bs > 0 && t[bs] !== "[") bs--;
  console.log("bracket start:", bs, "char:", t[bs]);

  // search for ,"generic" after payload start
  var ps = idx + marker.length;
  var found = false;
  var searchPos = ps;
  for (var attempt = 0; attempt < 20; attempt++) {
    var gi = t.indexOf(',"generic"', searchPos);
    if (gi < 0) { console.log("no more ,"+"generic\" found"); break; }
    console.log("attempt", attempt, "found ,"+"generic\" at:", gi, "prev char:", t[gi-1], "charCode:", t.charCodeAt(gi-1));

    // try parse from bracket start to after ]
    var cb = t.indexOf("]", gi + 10);
    if (cb >= 0) {
      var candidate = t.substring(bs, cb + 1);
      console.log("candidate length:", candidate.length);
      try {
        var arr = JSON.parse(candidate);
        console.log("PARSE OK! arr[0]:", arr[0], "arr[1]:", arr[1], "payload type:", typeof arr[2], "payload length:", (arr[2]||"").length);
        if (typeof arr[2] === "string") {
          var inner = JSON.parse(arr[2]);
          console.log("inner parse OK! turns:", inner[0] && inner[0].length, "title:", inner[4]);
        }
        found = true;
        break;
      } catch(e) {
        console.log("parse failed:", e.message.slice(0, 80));
      }
    }
    searchPos = gi + 1;
  }
  if (!found) console.log("ALL ATTEMPTS FAILED");
});