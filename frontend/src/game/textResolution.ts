import { Text, type Container } from 'pixi.js'

/**
 * 根が拡大されている（`uiScale` > 1）とき、Pixi Text は renderer.resolution の密度で作られて拡大されるためぼやける。
 * 木を辿り、各 Text の resolution を「renderer.resolution × 拡大率」に揃える（同じ値なら触らない＝再ラスタライズなし）。
 */
export function syncTextResolution(root: Container, resolution: number): void {
  if (!(resolution > 0) || !Number.isFinite(resolution)) return
  const stack: Container[] = [root]
  while (stack.length > 0) {
    const node = stack.pop() as Container
    if (node instanceof Text) {
      if (node.resolution !== resolution) node.resolution = resolution
      continue
    }
    for (const c of node.children) stack.push(c as Container)
  }
}
