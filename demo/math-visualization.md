# 数学函数的前端可视化

## 一元函数：可调正弦曲线

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

## 二元函数：等高线

```seamind-math
{
  "schemaVersion": 1,
  "kind": "contour-2d",
  "title": "f(x,y) = x² + y²",
  "expression": "x^2 + y^2",
  "domain": { "x": [-3, 3], "y": [-3, 3] },
  "levels": [1, 4, 9],
  "resolution": 80,
  "controls": {
    "domain": {
      "x": { "min": -4, "max": 4, "step": 0.25 },
      "y": { "min": -4, "max": 4, "step": 0.25 }
    }
  }
}
```

## 三维函数：高斯曲面

```seamind-math
{
  "schemaVersion": 1,
  "kind": "surface-3d",
  "title": "z = exp(-(x² + y²) / 4)",
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

## 向量场：绕原点旋转

```seamind-math
{
  "schemaVersion": 1,
  "kind": "vector-field-2d",
  "title": "F(x,y) = (-y, x)",
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

## 定积分：梯形近似

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
