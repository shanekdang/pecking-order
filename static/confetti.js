/* A burst of confetti (and the odd feather) over the whole page, drawn on
   the page's <canvas class="confetti">. Skipped for reduced motion. */
window.popConfetti = (function () {
  "use strict";
  var COLORS = ["#FFC94D", "#EE7C68", "#5D9CEC", "#8CCB7E", "#A57FE0", "#F28DB8", "#3FB8B0"];
  var frame = null;

  return function popConfetti() {
    var canvas = document.getElementById("confetti");
    if (!canvas || matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    var ctx = canvas.getContext("2d");
    var dpr = window.devicePixelRatio || 1;
    var w = window.innerWidth, h = window.innerHeight;
    canvas.width = w * dpr;
    canvas.height = h * dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    var pieces = [];
    for (var i = 0; i < 170; i++) {
      var fromLeft = i % 2 === 0;
      pieces.push({
        x: fromLeft ? -10 : w + 10,
        y: h * (0.35 + Math.random() * 0.4),
        vx: (fromLeft ? 1 : -1) * (4 + Math.random() * 9),
        vy: -(9 + Math.random() * 10),
        size: 6 + Math.random() * 7,
        spin: Math.random() * Math.PI,
        vspin: (Math.random() - 0.5) * 0.35,
        color: COLORS[i % COLORS.length],
        feather: i % 9 === 0
      });
    }

    if (frame) cancelAnimationFrame(frame);
    var start = performance.now();
    function draw(now) {
      ctx.clearRect(0, 0, w, h);
      var alive = false;
      pieces.forEach(function (p) {
        p.vy += 0.32;            // gravity
        p.vx *= 0.985;           // air
        p.x += p.vx;
        p.y += p.vy;
        p.spin += p.vspin;
        if (p.y < h + 30) alive = true;
        ctx.save();
        ctx.translate(p.x, p.y);
        ctx.rotate(p.spin);
        ctx.fillStyle = p.color;
        if (p.feather) {
          ctx.beginPath();
          ctx.ellipse(0, 0, p.size * 1.2, p.size * 0.45, 0, 0, Math.PI * 2);
          ctx.fill();
        } else {
          ctx.fillRect(-p.size / 2, -p.size / 4, p.size, p.size / 2 * (0.4 + Math.abs(Math.sin(p.spin))));
        }
        ctx.restore();
      });
      if (alive && now - start < 6000) frame = requestAnimationFrame(draw);
      else { ctx.clearRect(0, 0, w, h); frame = null; }
    }
    frame = requestAnimationFrame(draw);
  };
})();
