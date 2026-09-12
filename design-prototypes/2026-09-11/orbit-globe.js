/*
 * KeyAtlas / Orbit — an original, dependency-free design illustration.
 * All nodes and packets are decorative: no requests, credentials or tracking.
 * Dispatch a CustomEvent('orbit:toggle') on the host to pause or resume it.
 */
(() => {
  'use strict';

  const TAU = Math.PI * 2;
  const DEG = Math.PI / 180;
  const motionPreference = window.matchMedia('(prefers-reduced-motion: reduce)');
  const finePointer = window.matchMedia('(hover: hover) and (pointer: fine)');

  // Deliberately low-resolution, hand-authored geographic silhouettes.
  const landPolygons = [
    [[-166, 64], [-146, 72], [-128, 70], [-108, 76], [-81, 69], [-61, 53], [-77, 44], [-81, 26], [-97, 16], [-112, 31], [-128, 49], [-157, 57]],
    [[-81, 12], [-68, 10], [-51, 2], [-35, -7], [-43, -23], [-54, -36], [-68, -55], [-76, -36], [-80, -9]],
    [[-53, 60], [-43, 60], [-20, 76], [-40, 84], [-62, 79]],
    [[-18, 35], [0, 38], [13, 32], [32, 31], [44, 12], [51, 10], [39, -17], [23, -35], [12, -25], [7, -3], [-9, 5], [-18, 18]],
    [[-10, 36], [-10, 44], [6, 58], [24, 71], [39, 70], [47, 57], [36, 43], [25, 35], [15, 39]],
    [[30, 70], [71, 74], [115, 73], [151, 60], [176, 66], [165, 49], [137, 45], [121, 24], [106, 6], [99, 17], [80, 7], [69, 25], [51, 29], [33, 45]],
    [[112, -12], [137, -10], [154, -24], [147, -39], [129, -34], [113, -25]],
    [[45, -13], [51, -16], [47, -27], [43, -24]],
    [[129, 31], [142, 45], [146, 42], [135, 31]],
  ];

  const services = [
    { name: 'OpenAI', longitude: -57, latitude: 38, labelX: 0.15, labelY: 0.19, phase: 0.1 },
    { name: 'Anthropic', longitude: 49, latitude: 27, labelX: 0.84, labelY: 0.26, phase: 0.65 },
    { name: 'GitHub', longitude: -61, latitude: -29, labelX: 0.13, labelY: 0.73, phase: 0.35 },
    { name: 'MCP', longitude: 62, latitude: -38, labelX: 0.84, labelY: 0.78, phase: 0.85 },
  ];

  function insidePolygon(longitude, latitude, polygon) {
    let inside = false;
    for (let index = 0, previous = polygon.length - 1; index < polygon.length; previous = index++) {
      const [x1, y1] = polygon[index];
      const [x2, y2] = polygon[previous];
      if ((y1 > latitude) !== (y2 > latitude)
        && longitude < ((x2 - x1) * (latitude - y1)) / (y2 - y1) + x1) {
        inside = !inside;
      }
    }
    return inside;
  }

  function spherePoint(longitude, latitude, radius = 1) {
    const longitudeRadians = longitude * DEG;
    const latitudeRadians = latitude * DEG;
    return {
      x: Math.sin(longitudeRadians) * Math.cos(latitudeRadians) * radius,
      y: Math.sin(latitudeRadians) * radius,
      z: Math.cos(longitudeRadians) * Math.cos(latitudeRadians) * radius,
    };
  }

  const landPoints = [];
  for (let latitude = -56; latitude <= 79; latitude += 3) {
    const spacing = 3 / Math.max(0.3, Math.cos(latitude * DEG));
    for (let longitude = -180; longitude < 180; longitude += spacing) {
      if (landPolygons.some((polygon) => insidePolygon(longitude, latitude, polygon))) {
        landPoints.push(spherePoint(longitude, latitude));
      }
    }
  }

  function lockMarkup(id) {
    return `
      <div class="ka-orbit-halo" aria-hidden="true"></div>
      <div class="ka-orbit-underlight" aria-hidden="true"></div>
      <div class="ka-orbit-lock" aria-hidden="true">
        <svg viewBox="0 0 180 230" xmlns="http://www.w3.org/2000/svg" focusable="false">
          <defs>
            <linearGradient id="${id}-shackle" x1="0" y1="0" x2="1" y2="0">
              <stop offset="0" stop-color="#5a626e"/>
              <stop offset=".16" stop-color="#d2d5d7"/>
              <stop offset=".30" stop-color="#fdfdf9"/>
              <stop offset=".43" stop-color="#b3bac1"/>
              <stop offset=".60" stop-color="#f4f5f2"/>
              <stop offset=".77" stop-color="#8b939f"/>
              <stop offset="1" stop-color="#515b69"/>
            </linearGradient>
            <linearGradient id="${id}-face" x1="0" y1="0" x2=".9" y2="1">
              <stop offset="0" stop-color="#f4f4ee"/>
              <stop offset=".21" stop-color="#d2d5d5"/>
              <stop offset=".45" stop-color="#b5bbc0"/>
              <stop offset=".70" stop-color="#e2e5e4"/>
              <stop offset="1" stop-color="#a3abb4"/>
            </linearGradient>
            <linearGradient id="${id}-edge" x1="0" y1="0" x2="1" y2=".2">
              <stop offset="0" stop-color="#8c96a0"/>
              <stop offset=".46" stop-color="#495462"/>
              <stop offset="1" stop-color="#929ca6"/>
            </linearGradient>
            <linearGradient id="${id}-bevel" x1="0" y1="0" x2="1" y2="1">
              <stop offset="0" stop-color="#ffffff"/>
              <stop offset=".5" stop-color="#e3e6e5"/>
              <stop offset="1" stop-color="#79858f"/>
            </linearGradient>
            <pattern id="${id}-grain" width="4" height="3" patternUnits="userSpaceOnUse">
              <path d="M0 .5H4" stroke="#fff" stroke-opacity=".17" stroke-width=".35"/>
              <path d="M0 2H4" stroke="#344150" stroke-opacity=".055" stroke-width=".3"/>
            </pattern>
          </defs>
          <path d="M49 112V62C49 8 133 8 133 62V112" fill="none" stroke="#66717b" stroke-width="21" stroke-linejoin="round"/>
          <path d="M47 110V60C47 7 131 7 131 60V110" fill="none" stroke="url(#${id}-shackle)" stroke-width="18"/>
          <path d="M40 98V60C40 37 59 19 83 18" fill="none" stroke="#fffffa" stroke-opacity=".83" stroke-width="1.2"/>
          <path d="M143 101L164 109Q173 113 173 125V204Q173 216 163 221L143 225Z" fill="url(#${id}-edge)"/>
          <rect x="14" y="101" width="145" height="123" rx="17" fill="url(#${id}-bevel)"/>
          <rect x="17" y="104" width="138" height="116" rx="14" fill="url(#${id}-face)"/>
          <rect x="17" y="104" width="138" height="116" rx="14" fill="url(#${id}-grain)"/>
          <path d="M31 105H140Q154 105 154 120" fill="none" stroke="#fff" stroke-opacity=".8" stroke-width="1"/>
          <path d="M19 201V119Q19 108 30 107" fill="none" stroke="#fff" stroke-opacity=".6" stroke-width=".6"/>
          <circle cx="86" cy="158" r="18" fill="#89949f" fill-opacity=".34" stroke="#f2f5f6" stroke-opacity=".65" stroke-width=".8"/>
          <circle cx="86" cy="158" r="14.5" fill="#2d3948"/>
          <circle cx="86" cy="154" r="4.2" fill="#7f99dd"/>
          <path d="M84 157H88L89.5 164H82.5Z" fill="#7f99dd"/>
          <path d="M69 196H103" stroke="#6c7885" stroke-width=".7" opacity=".48"/>
          <path d="M74 200H98" stroke="#fff" stroke-width=".5" opacity=".6"/>
          <path d="M164 120V205" stroke="#d1d7dc" stroke-opacity=".35" stroke-width=".8"/>
        </svg>
      </div>`;
  }

  function initialize(host, index) {
    if (host.dataset.orbitInitialized === 'true') return;
    host.dataset.orbitInitialized = 'true';
    if (!host.hasAttribute('role')) host.setAttribute('role', 'img');
    if (!host.hasAttribute('aria-label')) {
      host.setAttribute('aria-label', 'KeyAtlas 디자인 시안: 회전하는 지구와 중앙 잠금장치, 서비스 연결을 표현한 장식입니다. 실제 연결 상태가 아닙니다.');
    }

    const canvas = document.createElement('canvas');
    canvas.className = 'ka-orbit-canvas';
    canvas.setAttribute('aria-hidden', 'true');
    host.append(canvas);
    host.insertAdjacentHTML('beforeend', lockMarkup(`ka-orbit-${index}`));
    const lock = host.querySelector('.ka-orbit-lock');
    const context = canvas.getContext('2d', { alpha: true });

    if (!context) {
      host.dataset.orbitFallback = 'true';
      host.dataset.motion = 'paused';
      return;
    }

    let width = 1;
    let height = 1;
    let radius = 1;
    let visible = true;
    let paused = motionPreference.matches;
    let frame = 0;
    let elapsed = 0;
    let lastTime = 0;
    let lastDraw = 0;
    let pointerX = 0;
    let pointerY = 0;
    let smoothX = 0;
    let smoothY = 0;
    let dark = host.dataset.orbitTheme === 'dark';

    function ink(opacity) {
      return dark ? `rgba(210,219,234,${opacity})` : `rgba(40,51,67,${opacity})`;
    }

    function signal(opacity) {
      return dark ? `rgba(133,160,251,${opacity})` : `rgba(37,74,216,${opacity})`;
    }

    function project(point, rotation = elapsed * 0.032 - 0.16) {
      const cosine = Math.cos(rotation + smoothX * 0.07);
      const sine = Math.sin(rotation + smoothX * 0.07);
      const rotatedX = point.x * cosine + point.z * sine;
      const rotatedZ = point.z * cosine - point.x * sine;
      const tilt = -0.2 + smoothY * 0.035;
      const rotatedY = point.y * Math.cos(tilt) - rotatedZ * Math.sin(tilt);
      const depth = point.y * Math.sin(tilt) + rotatedZ * Math.cos(tilt);
      const perspective = 3.7 / (3.7 - depth * 0.24);
      return {
        x: width * 0.5 + rotatedX * radius * perspective,
        y: height * 0.49 - rotatedY * radius * perspective,
        z: depth,
        scale: perspective,
      };
    }

    function dot(x, y, size, fill) {
      context.beginPath();
      context.arc(x, y, size, 0, TAU);
      context.fillStyle = fill;
      context.fill();
    }

    function drawGrid() {
      for (let latitude = -60; latitude <= 60; latitude += 30) {
        for (let longitude = -180; longitude < 180; longitude += 3) {
          const point = project(spherePoint(longitude, latitude));
          dot(point.x, point.y, point.z > 0 ? 0.66 : 0.44, ink(point.z > 0 ? 0.19 : 0.065));
        }
      }
      for (let longitude = 0; longitude < 360; longitude += 30) {
        for (let latitude = -87; latitude <= 87; latitude += 3) {
          const point = project(spherePoint(longitude, latitude));
          dot(point.x, point.y, point.z > 0 ? 0.66 : 0.44, ink(point.z > 0 ? 0.19 : 0.065));
        }
      }
      for (const landPoint of landPoints) {
        const point = project(landPoint);
        const front = Math.max(0, point.z);
        dot(point.x, point.y, (0.66 + front * 0.47) * Math.min(width / 650, 1.1), ink(point.z > 0 ? 0.20 + front * 0.28 : 0.055));
      }
    }

    // Tilted 3D great circles establish depth through front/back opacity.
    function drawOrbit(inclination, phase, isSignal) {
      const offset = elapsed * 0.012 + phase;
      let previous = null;
      for (let step = 0; step <= 150; step += 1) {
        const angle = step / 150 * TAU;
        const point = project({
          x: Math.cos(angle) * 1.08,
          y: Math.sin(angle) * Math.sin(inclination) * 1.08,
          z: Math.sin(angle) * Math.cos(inclination) * 1.08,
        }, offset);
        if (previous) {
          context.beginPath();
          context.moveTo(previous.x, previous.y);
          context.lineTo(point.x, point.y);
          context.strokeStyle = isSignal
            ? signal(point.z > 0 ? 0.30 : 0.075)
            : ink(point.z > 0 ? 0.20 : 0.06);
          context.lineWidth = isSignal ? 0.85 : 0.6;
          context.stroke();
        }
        previous = point;
      }
      const packetAngle = (elapsed * 0.13 + phase) % TAU;
      const packet = project({
        x: Math.cos(packetAngle) * 1.08,
        y: Math.sin(packetAngle) * Math.sin(inclination) * 1.08,
        z: Math.sin(packetAngle) * Math.cos(inclination) * 1.08,
      }, offset);
      if (packet.z > 0) {
        dot(packet.x, packet.y, 2, isSignal ? signal(0.9) : ink(0.7));
      }
    }

    function curvePoint(start, control, finish, progress) {
      const inverse = 1 - progress;
      return {
        x: inverse * inverse * start.x + 2 * inverse * progress * control.x + progress * progress * finish.x,
        y: inverse * inverse * start.y + 2 * inverse * progress * control.y + progress * progress * finish.y,
      };
    }

    function drawService(service) {
      // Slow orbital sway keeps service labels readable while the Earth rotates.
      const point = project(spherePoint(service.longitude, service.latitude), -0.16 + Math.sin(elapsed * 0.07) * 0.08);
      const anchor = { x: width * 0.5, y: height * 0.48 };
      const control = {
        x: point.x * 0.65 + anchor.x * 0.35,
        y: point.y * 0.6 + anchor.y * 0.4 - radius * 0.13,
      };
      context.beginPath();
      context.moveTo(point.x, point.y);
      context.quadraticCurveTo(control.x, control.y, anchor.x, anchor.y);
      context.strokeStyle = signal(0.36);
      context.lineWidth = 0.8;
      context.stroke();

      const progress = (elapsed * 0.14 + service.phase) % 1;
      const packet = curvePoint(point, control, anchor, progress);
      dot(packet.x, packet.y, 1.8, signal(0.84));
      dot(point.x, point.y, 7, dark ? 'rgba(23,28,36,.92)' : 'rgba(242,241,235,.94)');
      context.beginPath();
      context.arc(point.x, point.y, 6.5, 0, TAU);
      context.strokeStyle = signal(0.48);
      context.lineWidth = 0.7;
      context.stroke();
      dot(point.x, point.y, 2.2, signal(0.88));

      const label = { x: width * service.labelX, y: height * service.labelY };
      const left = service.labelX < 0.5;
      const lineEnd = { x: label.x + (left ? 8 : -8), y: label.y + 11 };
      context.beginPath();
      context.moveTo(point.x, point.y);
      context.lineTo(lineEnd.x, lineEnd.y);
      context.strokeStyle = ink(0.18);
      context.lineWidth = 0.65;
      context.stroke();
      context.font = `500 ${Math.max(10, Math.min(12, width * 0.018))}px "SFMono-Regular", Consolas, monospace`;
      context.textAlign = left ? 'left' : 'right';
      context.textBaseline = 'middle';
      context.fillStyle = ink(0.73);
      context.fillText(service.name, label.x, label.y);
    }

    function draw() {
      dark = host.dataset.orbitTheme === 'dark';
      context.clearRect(0, 0, width, height);
      drawGrid();
      drawOrbit(0.32, 0.7, false);
      drawOrbit(-0.70, -0.75, true);
      drawOrbit(1.04, 1.7, false);
      services.forEach(drawService);
      lock.style.transform = `translate(-50%, -50%) perspective(900px) rotateY(${-12 + smoothX * 7}deg) rotateX(${7 - smoothY * 5}deg) rotateZ(-5deg) translateY(${Math.sin(elapsed * 0.65) * 2}px)`;
    }

    function shouldAnimate() {
      return !paused && visible && !document.hidden;
    }

    function tick(time) {
      frame = 0;
      if (!shouldAnimate()) return;
      if (!lastTime) lastTime = time;
      elapsed += Math.min((time - lastTime) / 1000, 0.06);
      lastTime = time;
      if (time - lastDraw >= 1000 / 30) {
        smoothX += (pointerX - smoothX) * 0.07;
        smoothY += (pointerY - smoothY) * 0.07;
        draw();
        lastDraw = time;
      }
      frame = window.requestAnimationFrame(tick);
    }

    function syncAnimation() {
      host.dataset.motion = paused ? 'paused' : 'playing';
      if (frame) window.cancelAnimationFrame(frame);
      frame = 0;
      lastTime = 0;
      if (shouldAnimate()) frame = window.requestAnimationFrame(tick);
    }

    function resize() {
      const rect = host.getBoundingClientRect();
      width = Math.max(1, rect.width);
      height = Math.max(1, rect.height);
      radius = Math.min(width * 0.365, height * 0.415);
      const ratio = Math.min(window.devicePixelRatio || 1, 2);
      canvas.width = Math.round(width * ratio);
      canvas.height = Math.round(height * ratio);
      context.setTransform(ratio, 0, 0, ratio, 0, 0);
      draw();
    }

    host.addEventListener('orbit:toggle', () => {
      paused = !paused;
      syncAnimation();
      host.dispatchEvent(new CustomEvent('orbit:motionchange', { detail: { paused } }));
    });

    host.addEventListener('pointermove', (event) => {
      if (!finePointer.matches || paused) return;
      const rect = host.getBoundingClientRect();
      pointerX = (event.clientX - rect.left) / width * 2 - 1;
      pointerY = (event.clientY - rect.top) / height * 2 - 1;
    }, { passive: true });

    host.addEventListener('pointerleave', () => {
      pointerX = 0;
      pointerY = 0;
    });

    document.addEventListener('visibilitychange', syncAnimation);
    motionPreference.addEventListener('change', () => {
      paused = motionPreference.matches;
      syncAnimation();
      draw();
      host.dispatchEvent(new CustomEvent('orbit:motionchange', { detail: { paused } }));
    });

    if ('ResizeObserver' in window) {
      new ResizeObserver(resize).observe(host);
    } else {
      window.addEventListener('resize', resize, { passive: true });
    }

    if ('IntersectionObserver' in window) {
      new IntersectionObserver((entries) => {
        visible = entries[0].isIntersecting;
        syncAnimation();
      }, { threshold: 0.01 }).observe(host);
    }

    resize();
    syncAnimation();
  }

  function initializeAll() {
    document.querySelectorAll('[data-orbit-globe]').forEach(initialize);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initializeAll, { once: true });
  } else {
    initializeAll();
  }
})();
