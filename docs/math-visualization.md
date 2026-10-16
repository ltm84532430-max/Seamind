# Seamind 数学可视化代码块

数学描述保存在 Markdown 中，思维导图节点负责渲染和交互。代码围栏语言为 seamind-math（seamind-viz 也兼容），内容是 schemaVersion 1 的 JSON。

## 支持的图表

| kind            | 输入                           | 展示                                 |
| --------------- | ------------------------------ | ------------------------------------ |
| function-2d     | expression、domain.x           | 一元函数曲线                         |
| contour-2d      | expression、domain.x/y、levels | 二元函数等高线                       |
| vector-field-2d | vector.u/v、domain.x/y         | 二元向量场                           |
| integral-1d     | expression、domain.x、interval | 函数曲线、积分区间阴影和梯形近似结果 |
| surface-3d      | expression、domain.x/y         | 可旋转、缩放的三维函数曲面           |

## 参数滑块与 Markdown 回写

在 parameters 中声明参数值、最小值、最大值和步长，表达式可引用这些参数。controls.domain 可为 x/y 坐标范围声明滑块边界，积分图可用 controls.interval 调整积分区间。滑动时图表即时预览；点击“应用到 Markdown”后，参数才写回当前代码围栏。

点击图表卡片会选中该思维导图节点，并在 Markdown 编辑器中定位、选中对应的整个代码块。操作滑块或按钮时不会触发节点定位。

三维曲面按 `z = f(x,y)` 采样，并在思维导图节点内绘制网格；拖动可旋转视角，滚轮可缩放。采样在可终止的 Worker 中执行，最多 50 × 50 个网格单元。

## 示例

### 可调正弦曲线

```seamind-math
{
  "schemaVersion": 1,
  "kind": "function-2d",
  "title": "y = a sin(x)",
  "expression": "a*sin(x)",
  "domain": { "x": [-10, 10] },
  "samples": 320,
  "parameters": {
    "a": { "label": "振幅 a", "value": 1, "min": 0.25, "max": 2, "step": 0.05 }
  },
  "controls": {
    "domain": { "x": { "min": -12, "max": 12, "step": 0.5 } }
  }
}
```

### 向量场

```seamind-math
{
  "schemaVersion": 1,
  "kind": "vector-field-2d",
  "title": "旋转向量场",
  "vector": { "u": "-y", "v": "x" },
  "domain": { "x": [-3, 3], "y": [-3, 3] },
  "resolution": 10,
  "controls": {
    "domain": {
      "x": { "min": -4, "max": 4, "step": 0.25 },
      "y": { "min": -4, "max": 4, "step": 0.25 }
    }
  }
}
```

### 定积分近似

```seamind-math
{
  "schemaVersion": 1,
  "kind": "integral-1d",
  "title": "抛物线下的面积",
  "expression": "a*x^2",
  "domain": { "x": [0, 4] },
  "interval": [0, 3],
  "samples": 320,
  "parameters": {
    "a": { "label": "系数 a", "value": 1, "min": 0.2, "max": 2, "step": 0.1 }
  },
  "controls": {
    "interval": { "min": 0, "max": 4, "step": 0.1 }
  }
}
```

### 三维曲面

```seamind-math
{
  "schemaVersion": 1,
  "kind": "surface-3d",
  "title": "高斯曲面",
  "expression": "exp(-(x^2+y^2)/4)",
  "domain": { "x": [-4, 4], "y": [-4, 4] },
  "resolution": 32,
  "controls": {
    "domain": {
      "x": { "min": -5, "max": 5, "step": 0.25 },
      "y": { "min": -5, "max": 5, "step": 0.25 }
    }
  }
}
```

二维等高线示例见 [demo/math-visualization.md](../demo/math-visualization.md)。

## 安全限制

- 变量为 x、y 和已声明的参数；常量为 pi、e。
- 运算符支持 +、-、\*、/、^ 和括号；函数包括三角、反三角、双曲、指数、对数、平方根和取整函数。
- 不执行 JavaScript；不支持赋值、属性访问、隐式乘法或逗号参数。
- 计算在可终止的 Web Worker 中执行，并限制表达式长度、树深度、参数数量、采样量、分辨率、坐标范围和等高线路径数。
- 函数与积分采样为 50 至 2,000；等高线分辨率为 20 至 100；向量场分辨率为 5 至 20。
- 三维曲面分辨率为 8 至 50；渲染只接受已采样数值网格，不执行用户提供的代码。
