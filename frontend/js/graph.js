console.log("[graph] graph.js module loaded");

/**
 * Knowledge graph renderer.
 *
 * Renders nodes (things) and edges (semantic relationships) as an SVG graph
 * inside a modal. Starts from a deterministic circle layout (Option B) and
 * supports pan (drag background), zoom (wheel), and drag-to-reposition nodes.
 * Positions are session-only: reopening the graph resets to the deterministic
 * layout.
 */

const NODE_RADIUS_BASE = 18;
const NODE_RADIUS_MAX = 34;
const MIN_RADIUS = 600;
const LAYOUT_PADDING = 60;
const ZOOM_MIN = 0.1;
const ZOOM_MAX = 3;

// Force-directed layout constants
const FORCE_ITERATIONS = 100000;
const FORCE_K = 60;      // ideal distance between nodes
const FORCE_TEMP = 90;    // initial max movement per step
const FORCE_COOLING = 0.97;
const FORCE_GRAVITY = 0.02; // weak pull toward center of mass \u2013 prevents nodes from drifting to edges
const FORCE_REPULSION = 100000.0; // repulsion strength between all node pairs \u2013 set to 0 to disable
const FORCE_ATTRACTION = 0.5; // multiplier on edge attraction strength \u2013 higher = nodes pulled closer together
const MIN_EDGE_LENGTH = 50; // edges shorter than this no longer attract
const DOUBLE_CLICK_DELAY = 300; // ms within which a second click counts as a double-click
const BACKGROUND_CLICK_THRESHOLD = 3; // max px moved between mousedown/mouseup to count as a click

export function createGraph(containerEl) {
  let svg = null;
  let g = null; // the transform group (pan/zoom applies here)
  let nodesLayer = null;
  let edgesLayer = null;

  let nodes = [];
  let edges = [];
  let nodePositions = new Map(); // id -> {x, y}
  let nodeRadius = new Map(); // id -> radius

  let zoom = 1;
  let originX = 0;
  let originY = 0;

  // Drag state
  let draggingNodeId = null;
  let dragStartX = 0;
  let dragStartY = 0;
  let dragOriginPos = new Map(); // id -> {x, y} captured at drag start for every dragged node

  // Selection state
  let selectedNodeIds = new Set();

  // Double-click detection
  let lastClickTime = 0;
  let lastClickNodeId = null;

  // Edge drag state
  let draggingEdgeIndex = null;
  let edgeDragStartClientX = 0;
  let edgeDragStartClientY = 0;
  let edgeDragStartOffset = { dx: 0, dy: 0 };
  let edgeOffsets = new Map(); // edge index -> {dx, dy}
  let hasSavedLayout = false;
  let hasSavedEdgeOffsets = false;

  // Pan state
  let panning = false;
  let panStartX = 0;
  let panStartY = 0;
  let panOriginX = 0;
  let panOriginY = 0;

  let width = 0;
  let height = 0;

  function init() {
    containerEl.replaceChildren();

    svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("class", "graph-svg");
    svg.setAttribute("tabindex", "0");
    svg.setAttribute("aria-label", "Knowledge graph");
    containerEl.appendChild(svg);

    // Defs for edge markers
    const defs = document.createElementNS("http://www.w3.org/2000/svg", "defs");
    const marker = document.createElementNS("http://www.w3.org/2000/svg", "marker");
    marker.setAttribute("id", "arrowhead");
    marker.setAttribute("viewBox", "-0 -5 10 10");
    marker.setAttribute("refX", "10");
    marker.setAttribute("refY", "0");
    marker.setAttribute("markerWidth", "6");
    marker.setAttribute("markerHeight", "6");
    marker.setAttribute("orient", "auto");
    const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
    path.setAttribute("d", "M0,-5L10,0L0,5");
    path.setAttribute("fill", "#94a3b8");
    marker.appendChild(path);
    defs.appendChild(marker);
    svg.appendChild(defs);

    g = document.createElementNS("http://www.w3.org/2000/svg", "g");
    svg.appendChild(g);

    edgesLayer = document.createElementNS("http://www.w3.org/2000/svg", "g");
    edgesLayer.setAttribute("class", "graph-edges");
    g.appendChild(edgesLayer);

    nodesLayer = document.createElementNS("http://www.w3.org/2000/svg", "g");
    nodesLayer.setAttribute("class", "graph-nodes");
    g.appendChild(nodesLayer);

    applyTransform();

    // Wheel zoom
    svg.addEventListener("wheel", onWheel, { passive: false });

    // Background pan (mousedown on svg, not on a node/edge)
    svg.addEventListener("mousedown", onBackgroundMouseDown);

    // Global mouse move / up (on window so we don't lose drag outside svg)
    window.addEventListener("mousemove", onMouseMove);
    window.addEventListener("mouseup", onMouseUp);
    window.addEventListener("keydown", onKeyDown);

    // Resize
    window.addEventListener("resize", onResize);
    onResize();
  }

  function onResize() {
    const rect = containerEl.getBoundingClientRect();
    const nextWidth = Math.max(rect.width, 300);
    const nextHeight = Math.max(rect.height, 200);
    if (nextWidth !== width || nextHeight !== height) {
      width = nextWidth;
      height = nextHeight;
      svg.setAttribute("width", String(width));
      svg.setAttribute("height", String(height));
      // Re-center origin when resizing
      originX = width / 2;
      originY = height / 2;
      if (nodes.length > 0) {
        layoutNodes();
        render();
      } else {
        applyTransform();
      }
    }
  }

  function setGraph(nextNodes, nextEdges) {
    nodes = nextNodes;
    edges = nextEdges;
    selectedNodeIds.clear();

    // Compute degree per node for sizing
    const degree = new Map();
    for (const node of nodes) degree.set(node.id, 0);
    for (const edge of edges) {
      degree.set(edge.source, (degree.get(edge.source) ?? 0) + 1);
      degree.set(edge.target, (degree.get(edge.target) ?? 0) + 1);
    }

    const maxDegree = Math.max(1, ...degree.values());
    for (const node of nodes) {
      const d = degree.get(node.id) ?? 0;
      // Size scales with degree but caps at NODE_RADIUS_MAX
      const r = NODE_RADIUS_BASE + (d / maxDegree) * (NODE_RADIUS_MAX - NODE_RADIUS_BASE);
      nodeRadius.set(node.id, r);
    }

    // Reset zoom/pan for new graph
    zoom = 1;
    originX = width / 2;
    originY = height / 2;

    // Restore saved layout if nodes/edges carry positions; otherwise fall back
    // to the deterministic circle layout.
    hasSavedLayout = nodes.every((n) => n.x != null && n.y != null);
    hasSavedEdgeOffsets = edges.every((e) => e.dx != null && e.dy != null);

    if (hasSavedLayout) {
      for (const node of nodes) {
        nodePositions.set(node.id, { x: node.x, y: node.y });
      }
    } else {
      layoutNodes();
    }

    if (hasSavedEdgeOffsets) {
      edgeOffsets = new Map();
      for (let i = 0; i < edges.length; i += 1) {
        edgeOffsets.set(i, { dx: edges[i].dx, dy: edges[i].dy });
      }
    } else {
      edgeOffsets = new Map();
    }

    render();
    fitToView();
  }

  /** Auto-zoom and center so the entire graph fits visibly in the container. */
  function fitToView() {
    if (nodes.length === 0) return;

    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;

    for (const node of nodes) {
      const pos = nodePositions.get(node.id);
      if (!pos) continue;
      const r = nodeRadius.get(node.id) ?? NODE_RADIUS_BASE;
      minX = Math.min(minX, pos.x - r);
      minY = Math.min(minY, pos.y - r);
      maxX = Math.max(maxX, pos.x + r);
      maxY = Math.max(maxY, pos.y + r);
    }

    const graphWidth = maxX - minX;
    const graphHeight = maxY - minY;
    const centerX = (minX + maxX) / 2;
    const centerY = (minY + maxY) / 2;

    const padding = 40;
    const zoomX = (width - 2 * padding) / graphWidth;
    const zoomY = (height - 2 * padding) / graphHeight;
    zoom = Math.min(Math.max(Math.min(zoomX, zoomY), ZOOM_MIN), ZOOM_MAX);

    // Center the graph in the container: x' = x * zoom + originX = width / 2
    originX = width / 2 - centerX * zoom;
    originY = height / 2 - centerY * zoom;

    applyTransform();
  }

  /** Reset zoom/pan so the entire graph fits visibly in the container, like
   *  when the knowledge graph window is first opened. Preserves node positions
   *  (so dragged layouts are preserved) while rescaling and centering. */
  function center() {
    fitToView();
  }

  /** Run a force-directed (spring-embedder) layout iteratively, redrawing after
   *  each step so the user can watch nodes repel and edges pull them together.
   *  Works on top of existing positions (saved layout or circle layout) and
   *  preserves them afterward for dragging and saving. */
  async function autoLayout(iterations = FORCE_ITERATIONS) {
    if (nodes.length === 0) return;

    // Get actual current container size (modal may be much bigger than init size)
    const rect = containerEl.getBoundingClientRect();
    width = Math.max(rect.width, 300);
    height = Math.max(rect.height, 200);

    let temperature = FORCE_TEMP;

    // Start from each node's current position (saved layout, circle layout, or
    // manual drag) rather than randomising, so the force-directed simulation
    // refines the existing layout instead of discarding it.

    // Compute degree per node for both repulsion and attraction weighting
    const degree = new Map();
    for (const node of nodes) degree.set(node.id, 0);
    for (const edge of edges) {
      degree.set(edge.source, (degree.get(edge.source) ?? 0) + 1);
      degree.set(edge.target, (degree.get(edge.target) ?? 0) + 1);
    }

    const maxDegree = Math.max(1, ...degree.values());

    for (let i = 0; i < iterations; i++) {
      // Displacement accumulator per node id
      const displacement = new Map();
      for (const node of nodes) displacement.set(node.id, { dx: 0, dy: 0 });

      // Repulsion: every pair of nodes pushes apart (Coulomb-like)
      if (FORCE_REPULSION > 0) {
        for (let a = 0; a < nodes.length; a++) {
          for (let b = a + 1; b < nodes.length; b++) {
            const na = nodes[a];
            const nb = nodes[b];
            const pa = nodePositions.get(na.id);
            const pb = nodePositions.get(nb.id);
            if (!pa || !pb) continue;

            let dx = pa.x - pb.x;
            let dy = pa.y - pb.y;
            const dist = Math.max(Math.hypot(dx, dy), 1); // distance between nodes
            const minDegrees = Math.min(degree.get(na.id), degree.get(nb.id)) || 1;
            const force = FORCE_REPULSION * minDegrees / (dist * dist);
            const fx = (dx / dist) * force;
            const fy = (dy / dist) * force;

            const da = displacement.get(na.id);
            const db = displacement.get(nb.id);
            da.dx += fx;
            da.dy += fy;
            db.dx -= fx;
            db.dy -= fy;
          }
        }
      }

      // Attraction: every edge pulls its endpoints together (spring-like)
      if (FORCE_ATTRACTION > 0) {
        for (let i = 0; i < edges.length; i++) {
          const edge = edges[i];
          const pa = nodePositions.get(edge.source);
          const pb = nodePositions.get(edge.target);
          if (!pa || !pb) continue;

          let dx = pb.x - pa.x;
          let dy = pb.y - pa.y;
          const dist = Math.max(Math.hypot(dx, dy), 1);
          const minDegrees = Math.min(degree.get(edge.source),degree.get(edge.target)) || 1;
          const force = (FORCE_ATTRACTION * (dist - MIN_EDGE_LENGTH)) / minDegrees;
          const fx = (dx / dist) * force;
          const fy = (dy / dist) * force;

          const da = displacement.get(edge.source);
          const db = displacement.get(edge.target);
          da.dx += fx;
          da.dy += fy;
          db.dx -= fx;
          db.dy -= fy;
        }
      }

      // Gravity: weak pull toward center of mass to counteract outward drift from repulsion
      let gcX = 0;
      let gcY = 0;
      for (const node of nodes) {
        const p = nodePositions.get(node.id);
        gcX += p.x;
        gcY += p.y;
      }
      gcX /= nodes.length;
      gcY /= nodes.length;
      for (const node of nodes) {
        const p = nodePositions.get(node.id);
        const d = displacement.get(node.id);
        d.dx += (gcX - p.x) * FORCE_GRAVITY;
        d.dy += (gcY - p.y) * FORCE_GRAVITY;
      }

      // Apply displacements clamped by temperature
      for (const node of nodes) {
        const d = displacement.get(node.id);
        const dist = Math.hypot(d.dx, d.dy);
        if (dist > 0) {
          const scale = Math.min(dist, temperature) / dist;
          const pos = nodePositions.get(node.id);
          pos.x += d.dx * scale;
          pos.y += d.dy * scale;
        }
      }

      temperature *= FORCE_COOLING;

      render();
      await new Promise((resolve) => requestAnimationFrame(resolve));
    }

    // fitToView();
  }

  /** Return the current layout: node positions and edge offsets, suitable for
   *  persisting to graph.json so the layout survives across sessions. */
  function getLayout() {
    const nodeList = nodes.map((node) => {
      const pos = nodePositions.get(node.id);
      return {
        ...node,
        x: pos?.x ?? 0,
        y: pos?.y ?? 0,
      };
    });
    const edgeList = edges.map((edge, i) => {
      const offset = edgeOffsets.get(i) ?? { dx: 0, dy: 0 };
      return {
        ...edge,
        dx: offset.dx,
        dy: offset.dy,
      };
    });
    return { nodes: nodeList, edges: edgeList };
  }

  /** Deterministic circle layout (Option B). Nodes evenly spaced on a circle,
   *  sorted by degree so the most connected nodes are spread evenly too. */
  function layoutNodes() {
    const count = nodes.length;
    if (count === 0) return;

    const radius = Math.max(MIN_RADIUS, Math.min(width, height) / 2 - LAYOUT_PADDING);
    const cx = width / 2;
    const cy = height / 2;

    // Sort by degree descending for deterministic ordering
    const degree = new Map();
    for (const node of nodes) degree.set(node.id, 0);
    for (const edge of edges) {
      degree.set(edge.source, (degree.get(edge.source) ?? 0) + 1);
      degree.set(edge.target, (degree.get(edge.target) ?? 0) + 1);
    }
    const sorted = [...nodes].sort((a, b) => (degree.get(b.id) ?? 0) - (degree.get(a.id) ?? 0));

    for (let i = 0; i < sorted.length; i += 1) {
      const angle = (Math.PI * 2 * i) / count;
      const x = cx + radius * Math.cos(angle);
      const y = cy + radius * Math.sin(angle);
      nodePositions.set(sorted[i].id, { x, y });
    }
  }

  function applyTransform() {
    g.setAttribute(
      "transform",
      `translate(${originX}, ${originY}) scale(${zoom})`
    );
  }

  function render() {
    renderEdges();
    renderNodes();
    applyTransform();
  }

  function renderEdges() {
    edgesLayer.replaceChildren();
    for (let i = 0; i < edges.length; i += 1) {
      const edge = edges[i];
      const s = nodePositions.get(edge.source);
      const t = nodePositions.get(edge.target);
      if (!s || !t) continue;

      const offset = edgeOffsets.get(i) ?? { dx: 0, dy: 0 };

      // Curve endpoints are the centers of the two nodes.
      // Midpoint between source and target centers
      const mx = (s.x + t.x) / 2;
      const my = (s.y + t.y) / 2;

      // Control point for the quadratic BAczier curve: midpoint + offset.
      // offset = (0,0) yields a straight line; pulling the edge bends it.
      const cx = mx + offset.dx;
      const cy = my + offset.dy;

      const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
      path.setAttribute("class", "graph-edge");
      path.setAttribute("data-edge-index", String(i));
      path.setAttribute("d", `M ${s.x} ${s.y} Q ${cx} ${cy} ${t.x} ${t.y}`);
      path.setAttribute("stroke", "#94a3b8");
      path.setAttribute("stroke-width", "2");
      path.setAttribute("fill", "none");
      path.setAttribute("marker-end", "url(#arrowhead)");
      path.style.cursor = "pointer";
      path.addEventListener("mousedown", (event) => {
        event.stopPropagation();
        startEdgeDrag(i, event.clientX, event.clientY);
      });
      edgesLayer.appendChild(path);

      // Edge label at the true midpoint of the quadratic BAczier curve:
      // midpoint of curve = 0.5*s + 0.5*t + 0.5*offset = midpoint + 0.5*offset
      const labelX = mx + offset.dx / 2;
      const labelY = my + offset.dy / 2;
      const label = document.createElementNS("http://www.w3.org/2000/svg", "text");
      label.setAttribute("class", "graph-edge-label");
      label.setAttribute("x", String(labelX));
      label.setAttribute("y", String(labelY - 6));
      label.setAttribute("text-anchor", "middle");
      label.setAttribute("font-size", "10");
      label.setAttribute("fill", "#64748b");
      label.textContent = edge.relation;
      edgesLayer.appendChild(label);
    }
  }

  function renderNodes() {
    nodesLayer.replaceChildren();
    for (const node of nodes) {
      const pos = nodePositions.get(node.id);
      if (!pos) continue;
      const r = nodeRadius.get(node.id) ?? NODE_RADIUS_BASE;

      const isSelected = selectedNodeIds.has(node.id);
      const group = document.createElementNS("http://www.w3.org/2000/svg", "g");
      group.setAttribute(
        "class",
        "graph-node" + (isSelected ? " graph-node-selected" : "")
      );
      group.setAttribute("data-id", node.id);
      group.setAttribute("tabindex", "0");
      group.setAttribute("role", "button");
      group.setAttribute("aria-label", `${node.label} (${node.type})`);

      const circle = document.createElementNS("http://www.w3.org/2000/svg", "circle");
      circle.setAttribute("cx", String(pos.x));
      circle.setAttribute("cy", String(pos.y));
      circle.setAttribute("r", String(r));
      circle.setAttribute("fill", "#ffffff");
      circle.setAttribute("stroke", isSelected ? "#f59e0b" : "#2f6fed");
      circle.setAttribute("stroke-width", isSelected ? "3" : "2");
      circle.setAttribute("cursor", "pointer");
      group.appendChild(circle);

      const label = document.createElementNS("http://www.w3.org/2000/svg", "text");
      label.setAttribute("class", "graph-node-label");
      label.setAttribute("x", String(pos.x));
      label.setAttribute("y", String(pos.y + 4));
      label.setAttribute("text-anchor", "middle");
      label.setAttribute("font-size", "11");
      label.setAttribute("font-weight", "600");
      label.setAttribute("fill", "#1b2026");
      label.setAttribute("pointer-events", "none");
      label.textContent = node.label;
      group.appendChild(label);

      // Node drag / double-click: mousedown on the group
      group.addEventListener("mousedown", (event) => {
        event.stopPropagation();

        // Manual double-click detection: same node clicked twice within
        // DOUBLE_CLICK_DELAY ms. More reliable than the browser's dblclick
        // event on SVG elements (especially since render() recreates DOM nodes).
        const now = Date.now();
        const isDoubleClick = node.id === lastClickNodeId && now - lastClickTime < DOUBLE_CLICK_DELAY;
        lastClickTime = now;
        lastClickNodeId = node.id;

        if (isDoubleClick) {
          // Select this node plus all directly connected nodes (1 degree away),
          // replacing the current selection.
          const neighborIds = new Set();
          for (const edge of edges) {
            if (edge.source === node.id) neighborIds.add(edge.target);
            if (edge.target === node.id) neighborIds.add(edge.source);
          }
          selectedNodeIds.clear();
          selectedNodeIds.add(node.id);
          for (const id of neighborIds) selectedNodeIds.add(id);
          draggingNodeId = null;
          dragOriginPos.clear();
          render();
          return;
        }

        // Single-click selection: Ctrl/Cmd toggles, Shift adds, plain click on an
        // unselected node selects only that node. Plain click on an already-selected
        // node keeps the current selection (so the whole selection can be dragged).
        const wasSelected = selectedNodeIds.has(node.id);
        if (event.ctrlKey || event.metaKey) {
          if (wasSelected) selectedNodeIds.delete(node.id);
          else selectedNodeIds.add(node.id);
        } else if (event.shiftKey) {
          selectedNodeIds.add(node.id);
        } else if (!wasSelected) {
          selectedNodeIds.clear();
          selectedNodeIds.add(node.id);
        }
        render();
        startNodeDrag(node.id, event.clientX, event.clientY);
      });

      nodesLayer.appendChild(group);
    }
  }

  function startNodeDrag(nodeId, clientX, clientY) {
    draggingNodeId = nodeId;
    dragStartX = clientX;
    dragStartY = clientY;

    // Remember the starting position of every node that will move together so
    // they keep their relative positions while being dragged.
    dragOriginPos.clear();
    const ids = selectedNodeIds.size > 0 ? [...selectedNodeIds] : [nodeId];
    for (const id of ids) {
      const pos = nodePositions.get(id);
      if (pos) dragOriginPos.set(id, { x: pos.x, y: pos.y });
    }
  }

  function startEdgeDrag(edgeIndex, clientX, clientY) {
    draggingEdgeIndex = edgeIndex;
    edgeDragStartClientX = clientX;
    edgeDragStartClientY = clientY;
    edgeDragStartOffset = edgeOffsets.get(edgeIndex) ?? { dx: 0, dy: 0 };
  }

  function onMouseMove(event) {
    if (draggingNodeId !== null) {
      const dx = (event.clientX - dragStartX) / zoom;
      const dy = (event.clientY - dragStartY) / zoom;
      // Move every selected node by the same delta, preserving relative positions.
      const ids = selectedNodeIds.size > 0 ? [...selectedNodeIds] : [draggingNodeId];
      for (const id of ids) {
        const origin = dragOriginPos.get(id);
        const pos = nodePositions.get(id);
        if (!origin || !pos) continue;
        nodePositions.set(id, { x: origin.x + dx, y: origin.y + dy });
      }
      render();
      return;
    }

    if (draggingEdgeIndex !== null) {
      const dx = (event.clientX - edgeDragStartClientX) / zoom;
      const dy = (event.clientY - edgeDragStartClientY) / zoom;
      edgeOffsets.set(draggingEdgeIndex, {
        dx: edgeDragStartOffset.dx + dx,
        dy: edgeDragStartOffset.dy + dy,
      });
      render();
      return;
    }

    if (panning) {
      // Translation is applied after scaling in the SVG transform, so it's
      // already in screen pixels \u2013 no zoom compensation needed for 1:1 pan.
      const dx = event.clientX - panStartX;
      const dy = event.clientY - panStartY;
      originX = panOriginX + dx;
      originY = panOriginY + dy;
      applyTransform();
      return;
    }
  }

  function onMouseUp(event) {
    const wasPanning = panning;
    draggingNodeId = null;
    draggingEdgeIndex = null;
    panning = false;

    // If the user clicked the background without dragging (a click, not a pan),
    // clear the selection. If they dragged to pan, keep the selection intact.
    if (wasPanning && event) {
      const dx = Math.abs(event.clientX - panStartX);
      const dy = Math.abs(event.clientY - panStartY);
      if (dx <= BACKGROUND_CLICK_THRESHOLD && dy <= BACKGROUND_CLICK_THRESHOLD) {
        selectedNodeIds.clear();
        render();
      }
    }
  }

  function onKeyDown(event) {
    if (event.key === "Escape") {
      selectedNodeIds.clear();
      render();
    }
  }

  function onBackgroundMouseDown(event) {
    // Only start a pan if the click is on the SVG surface itself, not on a node.
    if (event.target !== svg && event.target !== g) return;
    panning = true;
    panStartX = event.clientX;
    panStartY = event.clientY;
    panOriginX = originX;
    panOriginY = originY;
  }

  function onWheel(event) {
    event.preventDefault();
    const delta = -event.deltaY / 200;
    const nextZoom = Math.min(Math.max(zoom * Math.exp(delta), ZOOM_MIN), ZOOM_MAX);
    if (nextZoom === zoom) return;

    // Zoom toward the mouse position
    const rect = svg.getBoundingClientRect();
    const mouseX = (event.clientX - rect.left - originX) / zoom;
    const mouseY = (event.clientY - rect.top - originY) / zoom;

    zoom = nextZoom;
    originX = event.clientX - rect.left - mouseX * zoom;
    originY = event.clientY - rect.top - mouseY * zoom;
    applyTransform();
  }

  function destroy() {
    window.removeEventListener("mousemove", onMouseMove);
    window.removeEventListener("mouseup", onMouseUp);
    window.removeEventListener("keydown", onKeyDown);
    window.removeEventListener("resize", onResize);
    if (svg) svg.removeEventListener("wheel", onWheel);
    if (svg) svg.removeEventListener("mousedown", onBackgroundMouseDown);
    containerEl.replaceChildren();
    svg = null;
    g = null;
    nodesLayer = null;
    edgesLayer = null;
    nodes = [];
    edges = [];
    nodePositions = new Map();
    nodeRadius = new Map();
    edgeOffsets = new Map();
  }

  /** Re-read the container size and re-center. Call when the modal becomes visible. */
  function resize() {
    onResize();
  }

  return {
    init,
    setGraph,
    resize,
    center,
    autoLayout,
    getLayout,
    getSvg: () => svg,
    destroy,
  };
}