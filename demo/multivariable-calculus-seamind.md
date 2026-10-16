<!-- markmap-desktop: {"id":"4fd70ff4-89da-43ef-9624-2e8f9ab5e8fa","title":"多元微积分：曲面、梯度与二重积分","mapType":"数学","tags":["多元微积分","SVG","HTML","ECharts","Python"],"createdAt":1792161284,"updatedAt":1792161706} -->

# 多元微积分：曲面、梯度与二重积分 <!-- seamind:id=7e64bf8e-d428-4501-b676-44548cedbc6a -->

从函数曲面开始，依次看偏导数、梯度方向和二重积分。图中包含可直接体验的 SVG、HTML、ECharts 与 Python 节点。

## 一、函数曲面与局部几何 <!-- seamind:id=ca52fe0e-93f9-4395-9e7e-f7237dfca0f8 -->

### 抛物面 z = x² + y² <!-- seamind:id=34514d1e-cf17-4a29-bf5b-d16e428d28fc -->

函数 $f(x,y)=x^2+y^2$ 把平面上的点映射到高度 $z$。点 $P=(1,1)$ 附近的切平面给出一阶近似：

$$
z\approx 2x+2y-2
$$

### SVG 节点：等高线与梯度方向 <!-- seamind:id=2e4152aa-4805-4b58-86e0-1e10d0e51290 -->

svg 围栏会被 Seamind 安全解析后直接绘制在思维导图节点里。

~~~svg
<svg xmlns="http://www.w3.org/2000/svg" width="420" height="230" viewBox="0 0 420 230" role="img" aria-label="抛物面等高线与梯度方向">
  <title>抛物面等高线与梯度方向</title>
  <desc>同心圆表示函数等高线，箭头表示梯度方向。</desc>
  <rect x="1" y="1" width="418" height="228" rx="12" fill="#f7f9fb" stroke="#d7e0e7" />
  <line x1="52" y1="112" x2="354" y2="112" stroke="#91a0ae" stroke-width="1.5" />
  <line x1="202" y1="205" x2="202" y2="24" stroke="#91a0ae" stroke-width="1.5" />
  <circle cx="202" cy="112" r="31" fill="none" stroke="#91a0ae" stroke-width="2" />
  <circle cx="202" cy="112" r="60" fill="none" stroke="#7898b1" stroke-width="2" />
  <circle cx="202" cy="112" r="88" fill="none" stroke="#688a79" stroke-width="2" />
  <line x1="202" y1="112" x2="279" y2="58" stroke="#c45e43" stroke-width="3" />
  <polygon points="279,58 263,61 273,73" fill="#c45e43" />
  <circle cx="202" cy="112" r="4" fill="#c45e43" />
  <text x="355" y="117" fill="#52616f" font-size="14">x</text>
  <text x="207" y="28" fill="#52616f" font-size="14">y</text>
  <text x="285" y="54" fill="#a64b35" font-size="14">∇f</text>
  <text x="285" y="100" fill="#667480" font-size="12">f = 1</text>
  <text x="282" y="82" fill="#587f98" font-size="12">f = 4</text>
  <text x="268" y="38" fill="#648773" font-size="12">f = 9</text>
  <text x="28" y="214" fill="#667480" font-size="12">梯度垂直于等高线，指向增长最快方向</text>
</svg>
~~~

### HTML 交互节点：拖动参数观察曲面 <!-- seamind:id=97ff7c8d-a73c-40d2-a450-df96e941a246 -->

点击 HTML 卡片打开交互画布，拖动 x、y 和方向滑块，观察曲面、切平面与等高线如何变化。

~~~seamind-html-card
{
  "assetId": "4a4cf6ae-eb0e-4269-9127-688c14f64cda",
  "entryPath": "multivariable-calculus.html",
  "title": "多元微积分交互曲面",
  "width": 500,
  "height": 320
}
~~~

## 二、偏导数与梯度：从公式到方向 <!-- seamind:id=26850f6d-7932-4cad-9ded-fce046bd3e9d -->

对于 $f(x,y)=x^2+y^2$，分别对两个变量求偏导，组合成梯度：

$$
\nabla f(x,y)=\left(\frac{\partial f}{\partial x},\frac{\partial f}{\partial y}\right)=(2x,2y)
$$

它指向函数增长最快的方向。

### ECharts 节点：函数的等高线 <!-- seamind:id=09d91ca8-3b55-416f-91a1-c747d417f4a5 -->

echarts 围栏会生成节点内 Canvas 图表；悬停可查看数据点。

~~~echarts
{
  "title": { "text": "f(x,y)=x²+y² 的等高线", "left": "center" },
  "tooltip": { "trigger": "axis" },
  "legend": { "bottom": 0 },
  "grid": { "left": 48, "right": 24, "top": 48, "bottom": 52 },
  "xAxis": { "type": "value", "min": -3, "max": 3, "name": "x" },
  "yAxis": { "type": "value", "min": -3, "max": 3, "name": "y" },
  "series": [
    { "name": "f=1", "type": "line", "smooth": true, "showSymbol": false, "data": [[1,0],[0.71,0.71],[0,1],[-0.71,0.71],[-1,0],[-0.71,-0.71],[0,-1],[0.71,-0.71],[1,0]] },
    { "name": "f=4", "type": "line", "smooth": true, "showSymbol": false, "data": [[2,0],[1.41,1.41],[0,2],[-1.41,1.41],[-2,0],[-1.41,-1.41],[0,-2],[1.41,-1.41],[2,0]] },
    { "name": "f=9", "type": "line", "smooth": true, "showSymbol": false, "data": [[3,0],[2.12,2.12],[0,3],[-2.12,2.12],[-3,0],[-2.12,-2.12],[0,-3],[2.12,-2.12],[3,0]] }
  ]
}
~~~

### Python 节点：本地计算并核对梯度 <!-- seamind:id=83b47e4d-774b-407a-a471-12a25a593e70 -->

点击“运行 Python”，在本机 Pyodide 环境计算，无需连接模型 API。

~~~python
# f(x,y) = x^2 + y^2 的梯度解析式为 (2x, 2y)
def f(x, y):
    return x * x + y * y

def gradient(x, y):
    return (2 * x, 2 * y)

x, y = 1.5, -1.0
dx, dy = gradient(x, y)
step = 1e-5
numeric_dx = (f(x + step, y) - f(x - step, y)) / (2 * step)
numeric_dy = (f(x, y + step) - f(x, y - step)) / (2 * step)

print("点 P =", (x, y), "函数值 f(P) =", f(x, y))
print("解析梯度 ∇f(P) =", (dx, dy))
print("中心差分校验 =", (round(numeric_dx, 5), round(numeric_dy, 5)))
~~~

## 三、二重积分：用小方块逼近体积 <!-- seamind:id=9c3d83c9-cce7-492a-8fc6-246be44c0bfd -->

将区域切成小方格，累加每格的“底面积 × 高度”，网格越细，黎曼和越接近真实体积：

$$
\iint_D f(x,y)\,dA\approx\sum_{i=1}^{m}\sum_{j=1}^{n}f(x_{ij}^*,y_{ij}^*)\Delta A
$$

### ECharts 节点：黎曼和收敛 <!-- seamind:id=366696e0-61be-4cd5-9e6b-5caf851e06b1 -->

对单位正方形上的 f(x,y)=x²+y² 计算中点黎曼和，虚线表示精确积分值 2/3。

~~~echarts
{
  "title": { "text": "中点黎曼和逐步收敛到 2/3", "left": "center" },
  "tooltip": { "trigger": "axis" },
  "legend": { "bottom": 0 },
  "grid": { "left": 55, "right": 24, "top": 48, "bottom": 52 },
  "xAxis": { "type": "category", "name": "网格边数 n", "data": [5, 10, 20, 40] },
  "yAxis": { "type": "value", "min": 0.64, "max": 0.67, "name": "积分近似值" },
  "series": [
    { "name": "中点黎曼和", "type": "line", "smooth": true, "symbolSize": 8, "data": [0.66, 0.665, 0.66625, 0.6665625] },
    { "name": "精确值 2/3", "type": "line", "showSymbol": false, "lineStyle": { "type": "dashed" }, "data": [0.6666667, 0.6666667, 0.6666667, 0.6666667] }
  ]
}
~~~

### Python 节点：自己生成中点黎曼和 <!-- seamind:id=dd2059ca-700c-4b00-85f4-4cb6e06712b5 -->

改动 n 可调采样密度。此代码生成的结果可以和上方图表核对。

~~~python
def f(x, y):
    return x * x + y * y

def midpoint_sum(n):
    dx = 1.0 / n
    total = 0.0
    for i in range(n):
        x = (i + 0.5) * dx
        for j in range(n):
            y = (j + 0.5) * dx
            total += f(x, y) * dx * dx
    return total

exact = 2.0 / 3.0
for n in (5, 10, 20, 40):
    estimate = midpoint_sum(n)
    print("n =", n, "近似 =", round(estimate, 7), "误差 =", round(abs(exact - estimate), 7))
~~~

## 四、节点里实际使用的格式 <!-- seamind:id=8373a28b-250f-42a1-ac4b-e5445c206489 -->

SVG：svg 围栏生成安全内嵌的图形节点。

HTML：seamind-html-card 围栏引用本图资源包里的 HTML 页面，点击卡片打开交互画布。

ECharts：echarts 围栏接收 JSON option，生成节点内 Canvas 图表。

Python：python 围栏生成可运行代码面板，点击即可执行并看到输出。
