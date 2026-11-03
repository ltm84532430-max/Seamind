import React, { useMemo } from 'react';
import type { CategoryStats, FeedChannelWithStats } from './types';

interface FeedGalaxyViewProps {
  categories: CategoryStats[];
  channels: FeedChannelWithStats[];
  onClose: () => void;
  onSelectCategory: (category: string) => void;
  onSelectChannel: (channelId: string) => void;
}

interface GalaxyNode {
  channel: FeedChannelWithStats;
  category: CategoryStats;
  x: number;
  y: number;
}

const CENTER_X = 500;
const CENTER_Y = 350;
const CATEGORY_RADIUS = 142;
const CHANNEL_RADIUS = 285;
const CATEGORY_LABEL_LIMIT = 16;

function snapPixel(value: number): number {
  return Math.round(value);
}

function categoryLabel(name: string): string {
  const characters = Array.from(name);
  return characters.length > CATEGORY_LABEL_LIMIT
    ? `${characters.slice(0, CATEGORY_LABEL_LIMIT - 1).join('')}…`
    : name;
}

export const FeedGalaxyView: React.FC<FeedGalaxyViewProps> = ({
  categories,
  channels,
  onClose,
  onSelectCategory,
  onSelectChannel,
}) => {
  const layout = useMemo(() => {
    const items = categories.map((category, index) => {
      const categoryAngle =
        -Math.PI / 2 + (Math.PI * 2 * index) / Math.max(categories.length, 1);
      const categoryNode = {
        category,
        x: snapPixel(CENTER_X + Math.cos(categoryAngle) * CATEGORY_RADIUS),
        y: snapPixel(CENTER_Y + Math.sin(categoryAngle) * CATEGORY_RADIUS),
      };
      const members = channels.filter(
        (channel) => channel.category === category.name,
      );
      const sector = (Math.PI * 2) / Math.max(categories.length, 1);
      const halfSpan = sector * 0.43;
      const nodes: GalaxyNode[] = members.map((channel, channelIndex) => {
        const angle =
          categoryAngle -
          halfSpan +
          (halfSpan * 2 * (channelIndex + 0.5)) / Math.max(members.length, 1);
        return {
          channel,
          category,
          x: snapPixel(CENTER_X + Math.cos(angle) * CHANNEL_RADIUS),
          y: snapPixel(CENTER_Y + Math.sin(angle) * CHANNEL_RADIUS),
        };
      });
      return { ...categoryNode, nodes };
    });
    return items;
  }, [categories, channels]);

  return (
    <section className="feed-galaxy-overlay" aria-label="订阅源星系视图">
      <header className="feed-galaxy-header">
        <div>
          <h2 className="feed-galaxy-title">订阅源星系</h2>
          <div className="feed-galaxy-subtitle">
            {categories.length} 个分类 · {channels.length} 个订阅源
          </div>
        </div>
        <button type="button" className="feed-text-btn" onClick={onClose}>
          返回列表
        </button>
      </header>

      <div className="feed-galaxy-map-wrap">
        <svg
          className="feed-galaxy-map"
          viewBox="0 0 1000 700"
          role="group"
          aria-label="中心节点连接分类节点，每个分类节点连接其订阅源"
        >
          <circle
            className="feed-galaxy-orbit"
            cx={CENTER_X}
            cy={CENTER_Y}
            r={CATEGORY_RADIUS}
          />
          <circle
            className="feed-galaxy-orbit is-outer"
            cx={CENTER_X}
            cy={CENTER_Y}
            r={CHANNEL_RADIUS}
          />

          {layout.map((group) => (
            <g key={`links-${group.category.name}`}>
              <line
                className="feed-galaxy-category-link"
                x1={CENTER_X}
                y1={CENTER_Y}
                x2={group.x}
                y2={group.y}
                style={{ stroke: group.category.color }}
              />
              {group.nodes.map((node) => (
                <line
                  key={`link-${node.channel.id}`}
                  className="feed-galaxy-channel-link"
                  x1={group.x}
                  y1={group.y}
                  x2={node.x}
                  y2={node.y}
                  style={{ stroke: group.category.color }}
                />
              ))}
            </g>
          ))}

          <g className="feed-galaxy-center">
            <circle cx={CENTER_X} cy={CENTER_Y} r="34" />
            <text x={CENTER_X} y={CENTER_Y - 2} textAnchor="middle">
              SEAMIND
            </text>
            <text
              className="feed-galaxy-center-caption"
              x={CENTER_X}
              y={CENTER_Y + 13}
              textAnchor="middle"
            >
              RSS
            </text>
          </g>

          {layout.map((group) => (
            <g key={`category-${group.category.name}`}>
              <g
                className="feed-galaxy-category-node"
                role="button"
                tabIndex={0}
                aria-label={`分类 ${group.category.name}，${group.category.channelCount} 个订阅源`}
                onClick={() => onSelectCategory(group.category.name)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter' || event.key === ' ') {
                    event.preventDefault();
                    onSelectCategory(group.category.name);
                  }
                }}
              >
                <title>{group.category.name}</title>
                <circle
                  cx={group.x}
                  cy={group.y}
                  r="21"
                  style={{ fill: group.category.color }}
                />
                <text x={group.x} y={group.y + 4} textAnchor="middle">
                  {group.category.channelCount}
                </text>
                <text
                  className="feed-galaxy-category-label"
                  x={group.x}
                  y={group.y + 39}
                  textAnchor="middle"
                  aria-hidden="true"
                >
                  {categoryLabel(group.category.name)}
                </text>
              </g>

              {group.nodes.map((node) => (
                <g
                  key={`channel-${node.channel.id}`}
                  className="feed-galaxy-channel-node"
                  role="button"
                  tabIndex={0}
                  aria-label={`${node.channel.title}，分类：${node.category.name}`}
                  onClick={() => onSelectChannel(node.channel.id)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter' || event.key === ' ') {
                      event.preventDefault();
                      onSelectChannel(node.channel.id);
                    }
                  }}
                >
                  <circle
                    className="feed-galaxy-channel-hit-target"
                    cx={node.x}
                    cy={node.y}
                    r="13"
                  />
                  <circle
                    className="feed-galaxy-channel-dot"
                    cx={node.x}
                    cy={node.y}
                    r="6"
                    style={{ fill: node.category.color }}
                  />
                  <title>
                    {node.channel.title} — {node.category.name}
                    {'\n'}
                    {node.channel.url}
                  </title>
                </g>
              ))}
            </g>
          ))}
        </svg>
      </div>

      <footer className="feed-galaxy-footer">
        点击分类节点筛选文章，点击外圈节点打开对应订阅源。
      </footer>
    </section>
  );
};
