import { describe, expect, it } from 'vitest';
import { extractProposalFromText } from '../src/player/learning-path-parser';

describe('extractProposalFromText', () => {
  it('returns null for empty or irrelevant text', () => {
    expect(extractProposalFromText('Test', '')).toBeNull();
    expect(
      extractProposalFromText('Test', '你好，这是一段普通的问候。'),
    ).toBeNull();
  });

  it('parses markdown headings with youtube links into stages and videos', () => {
    const markdown = `
我为你规划了学习路线：

### 阶段 1：基础核心
- [TypeScript 基础入门教程](https://www.youtube.com/watch?v=ahCwqrYqo9o)
- 编译器配置与tsconfig实操 https://youtu.be/IOzkOXNz9Pk

### 阶段 2：高级类型与体操
- [类型体操进阶挑战](https://www.youtube.com/watch?v=fNk_zzaMoSs)
`;
    const result = extractProposalFromText('TypeScript 类型体操', markdown);
    expect(result).not.toBeNull();
    expect(result?.mode).toBe('create');
    expect(result?.stageCount).toBe(2);
    expect(result?.videoCount).toBe(3);
    expect(result?.input.videos?.length).toBe(3);

    const stageNodes = result?.input.nodes.filter((n) => n.kind === 'stage');
    expect(stageNodes?.length).toBe(2);
    expect(stageNodes?.[0].title).toBe('基础核心');
    expect(stageNodes?.[1].title).toBe('高级类型与体操');

    const videoNodes = result?.input.nodes.filter((n) => n.kind === 'video');
    expect(videoNodes?.length).toBe(3);
    expect(videoNodes?.[0].videoId).toBe('ahCwqrYqo9o');
    expect(videoNodes?.[1].videoId).toBe('IOzkOXNz9Pk');
    expect(videoNodes?.[2].videoId).toBe('fNk_zzaMoSs');

    // Automatically appends a checkpoint
    const checkpoint = result?.input.nodes.find((n) => n.kind === 'checkpoint');
    expect(checkpoint).toBeDefined();
  });

  it('parses outline topics even without video links', () => {
    const text = `
### 阶段一：Rust 语法与所有权
- 变量绑定与可变性
- 所有权与生命周期
### 阶段二：并发与异步运行时
- Tokio 与 async/await
- 消息通道与多线程
`;
    const result = extractProposalFromText('Rust 系统编程', text);
    expect(result).not.toBeNull();
    expect(result?.stageCount).toBe(2);
    expect(result?.videoCount).toBe(4);
  });
});
