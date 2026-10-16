import type {
  MathVisualizationSurface,
  Surface3dVisualization,
} from './math-visualization';

type AppTheme = 'light' | 'dark';

export interface MathSurface3dController {
  setSurface(
    spec: Surface3dVisualization,
    surface: MathVisualizationSurface,
  ): void;
  dispose(): void;
}

export function renderMathSurface3d(
  output: HTMLElement,
  theme: AppTheme,
  initialSpec: Surface3dVisualization,
  initialSurface: MathVisualizationSurface,
): MathSurface3dController {
  const canvas = document.createElement('canvas');
  canvas.className = 'seamind-surface3d-canvas';
  canvas.setAttribute('role', 'img');
  const hint = document.createElement('span');
  hint.className = 'seamind-surface3d-hint';
  hint.textContent = '拖动旋转 · 滚轮缩放';
  output.replaceChildren(canvas, hint);
  const context = canvas.getContext('2d');
  if (!context) throw new Error('无法创建三维曲面的 Canvas 渲染上下文。');

  let spec = initialSpec;
  let surface = initialSurface;
  let yaw = -0.72;
  let pitch = 0.82;
  let zoom = 1;
  let pointer: { id: number; x: number; y: number } | undefined;
  let disposed = false;
  let frame = 0;
  const dark = theme === 'dark';
  const palette = dark
    ? {
        axis: 'rgba(178, 196, 207, 0.7)',
        grid: 'rgba(144, 169, 183, 0.2)',
        text: '#bdcbd3',
        wire: 'rgba(14, 24, 29, 0.42)',
      }
    : {
        axis: 'rgba(71, 91, 103, 0.7)',
        grid: 'rgba(98, 123, 137, 0.2)',
        text: '#52636c',
        wire: 'rgba(255, 255, 255, 0.42)',
      };

  const draw = () => {
    frame = 0;
    if (disposed) return;
    const width = Math.max(1, output.clientWidth);
    const height = Math.max(1, output.clientHeight);
    const ratio = Math.min(2, Math.max(1, window.devicePixelRatio || 1));
    const pixelWidth = Math.round(width * ratio);
    const pixelHeight = Math.round(height * ratio);
    if (canvas.width !== pixelWidth || canvas.height !== pixelHeight) {
      canvas.width = pixelWidth;
      canvas.height = pixelHeight;
    }
    context.setTransform(ratio, 0, 0, ratio, 0, 0);
    context.clearRect(0, 0, width, height);
    context.font = '11px system-ui, sans-serif';
    context.fillStyle = palette.text;
    context.textAlign = 'center';
    context.textBaseline = 'top';
    context.fillText(spec.title || `z = ${spec.expression}`, width / 2, 10);

    const finiteValues = surface.zValues.flatMap((row) =>
      row.filter((value): value is number => value !== null),
    );
    if (!finiteValues.length) return;
    const minZ = Math.min(...finiteValues);
    const maxZ = Math.max(...finiteValues);
    const zScale = Math.max(Math.abs(minZ), Math.abs(maxZ), 1e-12);
    const scaledMin = minZ / zScale;
    const scaledMax = maxZ / zScale;
    const scaledRange = Math.max(scaledMax - scaledMin, 1e-12);
    const scaledMiddle = (scaledMin + scaledMax) / 2;
    const normalizedZ = (value: number) =>
      ((value / zScale - scaledMiddle) / (scaledRange / 2)) * 0.82;
    const xMin = surface.xValues[0] ?? -1;
    const xMax = surface.xValues[surface.xValues.length - 1] ?? 1;
    const yMin = surface.yValues[0] ?? -1;
    const yMax = surface.yValues[surface.yValues.length - 1] ?? 1;
    const cosineYaw = Math.cos(yaw);
    const sineYaw = Math.sin(yaw);
    const cosinePitch = Math.cos(pitch);
    const sinePitch = Math.sin(pitch);
    const scale = Math.min(width * 0.72, height * 0.66) * 0.5 * zoom;
    const centerX = width / 2;
    const centerY = height * 0.55;
    const project = (x: number, y: number, z: number) => {
      const xRotated = x * cosineYaw - y * sineYaw;
      const yRotated = x * sineYaw + y * cosineYaw;
      const yProjected = yRotated * cosinePitch - z * sinePitch;
      const depth = yRotated * sinePitch + z * cosinePitch;
      const perspective = 3.4 / (3.4 - depth * 0.3);
      return {
        x: centerX + xRotated * scale * perspective,
        y: centerY - yProjected * scale * perspective,
        depth,
      };
    };
    const normalizedX = (value: number) =>
      ((value - xMin) / Math.max(xMax - xMin, 1e-12)) * 2 - 1;
    const normalizedY = (value: number) =>
      ((value - yMin) / Math.max(yMax - yMin, 1e-12)) * 2 - 1;
    const baseZ = -0.92;

    context.strokeStyle = palette.grid;
    context.lineWidth = 1;
    for (let tick = 0; tick <= 4; tick += 1) {
      const offset = -1 + (tick / 4) * 2;
      const xStart = project(offset, -1, baseZ);
      const xEnd = project(offset, 1, baseZ);
      const yStart = project(-1, offset, baseZ);
      const yEnd = project(1, offset, baseZ);
      context.beginPath();
      context.moveTo(xStart.x, xStart.y);
      context.lineTo(xEnd.x, xEnd.y);
      context.moveTo(yStart.x, yStart.y);
      context.lineTo(yEnd.x, yEnd.y);
      context.stroke();
    }

    const triangles: Array<{
      points: Array<{ x: number; y: number; depth: number }>;
      depth: number;
      color: string;
    }> = [];
    for (let row = 0; row < surface.yValues.length - 1; row += 1) {
      for (let column = 0; column < surface.xValues.length - 1; column += 1) {
        const values = [
          surface.zValues[row]?.[column],
          surface.zValues[row]?.[column + 1],
          surface.zValues[row + 1]?.[column + 1],
          surface.zValues[row + 1]?.[column],
        ];
        if (!values.every((value) => value !== null && value !== undefined))
          continue;
        for (const cell of [
          [0, 1, 2],
          [0, 2, 3],
        ] as const) {
          const points = cell.map((index) => {
            const x =
              index === 1 || index === 2
                ? surface.xValues[column + 1]!
                : surface.xValues[column]!;
            const y =
              index === 2 || index === 3
                ? surface.yValues[row + 1]!
                : surface.yValues[row]!;
            return project(
              normalizedX(x),
              normalizedY(y),
              normalizedZ(values[index] as number),
            );
          });
          const meanZ =
            cell.reduce<number>(
              (sum, index) => sum + (values[index] as number),
              0,
            ) / cell.length;
          const colorValue = Math.min(
            1,
            Math.max(0, (meanZ / zScale - scaledMin) / scaledRange),
          );
          const lightness = dark ? 49 + colorValue * 14 : 45 + colorValue * 12;
          triangles.push({
            points,
            depth: points.reduce((sum, point) => sum + point.depth, 0) / 3,
            color: `hsl(${215 - colorValue * 178} 68% ${lightness}%)`,
          });
        }
      }
    }
    triangles.sort((left, right) => left.depth - right.depth);
    triangles.forEach((triangle) => {
      context.beginPath();
      context.moveTo(triangle.points[0]!.x, triangle.points[0]!.y);
      context.lineTo(triangle.points[1]!.x, triangle.points[1]!.y);
      context.lineTo(triangle.points[2]!.x, triangle.points[2]!.y);
      context.closePath();
      context.fillStyle = triangle.color;
      context.fill();
      context.strokeStyle = palette.wire;
      context.lineWidth = 0.55;
      context.stroke();
    });

    const drawMeshLine = (points: Array<{ x: number; y: number }>) => {
      if (points.length < 2) return;
      context.beginPath();
      points.forEach((point, index) => {
        if (index === 0) context.moveTo(point.x, point.y);
        else context.lineTo(point.x, point.y);
      });
      context.strokeStyle = palette.wire;
      context.lineWidth = 0.65;
      context.stroke();
    };
    const meshStride = Math.max(1, Math.floor(spec.resolution / 12));
    for (let row = 0; row < surface.yValues.length; row += meshStride) {
      const points: Array<{ x: number; y: number }> = [];
      for (let column = 0; column < surface.xValues.length; column += 1) {
        const value = surface.zValues[row]?.[column];
        if (value === null || value === undefined) {
          drawMeshLine(points.splice(0));
          continue;
        }
        points.push(
          project(
            normalizedX(surface.xValues[column]!),
            normalizedY(surface.yValues[row]!),
            normalizedZ(value),
          ),
        );
      }
      drawMeshLine(points);
    }
    for (
      let column = 0;
      column < surface.xValues.length;
      column += meshStride
    ) {
      const points: Array<{ x: number; y: number }> = [];
      for (let row = 0; row < surface.yValues.length; row += 1) {
        const value = surface.zValues[row]?.[column];
        if (value === null || value === undefined) {
          drawMeshLine(points.splice(0));
          continue;
        }
        points.push(
          project(
            normalizedX(surface.xValues[column]!),
            normalizedY(surface.yValues[row]!),
            normalizedZ(value),
          ),
        );
      }
      drawMeshLine(points);
    }

    const drawAxis = (
      start: { x: number; y: number; z: number },
      end: { x: number; y: number; z: number },
      label: string,
      labelOffset: [number, number],
    ) => {
      const a = project(start.x, start.y, start.z);
      const b = project(end.x, end.y, end.z);
      context.beginPath();
      context.moveTo(a.x, a.y);
      context.lineTo(b.x, b.y);
      context.strokeStyle = palette.axis;
      context.lineWidth = 1.15;
      context.stroke();
      context.fillStyle = palette.text;
      context.textAlign = 'center';
      context.textBaseline = 'middle';
      context.fillText(label, b.x + labelOffset[0], b.y + labelOffset[1]);
    };
    drawAxis(
      { x: -1, y: -1, z: baseZ },
      { x: 1, y: -1, z: baseZ },
      'x',
      [8, 4],
    );
    drawAxis(
      { x: -1, y: -1, z: baseZ },
      { x: -1, y: 1, z: baseZ },
      'y',
      [-8, 4],
    );
    drawAxis({ x: -1, y: -1, z: baseZ }, { x: -1, y: -1, z: 1 }, 'z', [-8, -2]);
    context.textBaseline = 'alphabetic';
    context.textAlign = 'left';
    context.fillStyle = palette.text;
    context.font = '10px system-ui, sans-serif';
    context.fillText(
      `z: ${formatAxisValue(minZ)} to ${formatAxisValue(maxZ)}`,
      12,
      height - 12,
    );
  };

  const requestDraw = () => {
    if (!frame && !disposed) frame = window.requestAnimationFrame(draw);
  };
  const handlePointerDown = (event: PointerEvent) => {
    if (event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    pointer = { id: event.pointerId, x: event.clientX, y: event.clientY };
    canvas.setPointerCapture(event.pointerId);
  };
  const handlePointerMove = (event: PointerEvent) => {
    if (!pointer || pointer.id !== event.pointerId) return;
    const deltaX = event.clientX - pointer.x;
    const deltaY = event.clientY - pointer.y;
    pointer = { ...pointer, x: event.clientX, y: event.clientY };
    yaw += deltaX * 0.009;
    pitch = Math.min(1.48, Math.max(0.12, pitch + deltaY * 0.008));
    requestDraw();
  };
  const handlePointerUp = (event: PointerEvent) => {
    if (pointer?.id !== event.pointerId) return;
    pointer = undefined;
    if (canvas.hasPointerCapture(event.pointerId))
      canvas.releasePointerCapture(event.pointerId);
  };
  const handleWheel = (event: WheelEvent) => {
    event.preventDefault();
    event.stopPropagation();
    zoom = Math.min(
      1.8,
      Math.max(0.65, zoom * (event.deltaY < 0 ? 1.08 : 0.92)),
    );
    requestDraw();
  };
  canvas.addEventListener('pointerdown', handlePointerDown);
  canvas.addEventListener('pointermove', handlePointerMove);
  canvas.addEventListener('pointerup', handlePointerUp);
  canvas.addEventListener('pointercancel', handlePointerUp);
  canvas.addEventListener('wheel', handleWheel, { passive: false });
  const resizeObserver = new ResizeObserver(requestDraw);
  resizeObserver.observe(output);

  const controller: MathSurface3dController = {
    setSurface(nextSpec, nextSurface) {
      spec = nextSpec;
      surface = nextSurface;
      canvas.setAttribute(
        'aria-label',
        nextSpec.title || `三维函数曲面 z = ${nextSpec.expression}`,
      );
      requestDraw();
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      resizeObserver.disconnect();
      if (frame) window.cancelAnimationFrame(frame);
      canvas.removeEventListener('pointerdown', handlePointerDown);
      canvas.removeEventListener('pointermove', handlePointerMove);
      canvas.removeEventListener('pointerup', handlePointerUp);
      canvas.removeEventListener('pointercancel', handlePointerUp);
      canvas.removeEventListener('wheel', handleWheel);
    },
  };
  controller.setSurface(initialSpec, initialSurface);
  return controller;
}

function formatAxisValue(value: number): string {
  return Number(value.toPrecision(4)).toString();
}
