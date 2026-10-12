function airPath(className, d, width, opacity) {
  const path = document.createElementNS(SVG_NS, 'path');
  path.setAttribute('class', className);
  path.setAttribute('d', d);
  path.style.strokeWidth = width.toFixed(2);
  path.style.opacity = opacity.toFixed(2);
  return path;
}

// Each strand is a faint continuous line with a brighter pulse travelling along it.
function buildStreaks() {
  const group = byId('streaks');
  const count = 18;
  for (let index = 0; index < count; index += 1) {
    const position = index / (count - 1);
    const fadeAtEdges = 1 - Math.abs(position - 0.5) * 0.9;
    const x = 78 + position * 164;
    const spread = (x - 160) * 0.45;
    const bend = random(-6, 6);
    const d = `M${x.toFixed(1)} 91 C${(x + bend).toFixed(1)} 112 ${(x + spread * 0.5 - bend).toFixed(1)} 138 ${(x + spread).toFixed(1)} 166`;
    const dash = random(26, 54);
    const gap = random(60, 120);
    const pulse = airPath('pulse', d, random(1.6, 3.6), random(0.3, 0.65) * fadeAtEdges);
    pulse.style.setProperty('--dash', `${dash.toFixed(1)}px`);
    pulse.style.setProperty('--gap', `${gap.toFixed(1)}px`);
    pulse.style.setProperty('--cycle', `${(dash + gap).toFixed(1)}px`);
    pulse.style.setProperty('--delay', `${(-random(0, 3)).toFixed(2)}s`);
    group.append(airPath('strand', d, random(1, 2.6), random(0.1, 0.2) * fadeAtEdges), pulse);
  }
}

function buildDrift() {
  const group = byId('drift');
  for (let index = 0; index < 44; index += 1) {
    const x = random(64, 256);
    const dot = document.createElementNS(SVG_NS, 'circle');
    dot.setAttribute('class', 'dot');
    dot.setAttribute('cx', x.toFixed(1));
    dot.setAttribute('cy', random(88, 98).toFixed(1));
    dot.setAttribute('r', random(0.9, 2.1).toFixed(2));
    dot.style.setProperty('--dx', `${((x - 160) * 0.12 + random(-6, 6)).toFixed(1)}px`);
    dot.style.setProperty('--dy', `${random(22, 62).toFixed(1)}px`);
    dot.style.setProperty('--dur', `${random(3.4, 7).toFixed(2)}s`);
    dot.style.setProperty('--delay', `${(-random(0, 7)).toFixed(2)}s`);
    group.append(dot);
  }
}
