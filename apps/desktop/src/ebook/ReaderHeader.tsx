import type { ReactNode } from 'react';
import './reader-header.css';

export default function ReaderHeader({
  className,
  headingClassName,
  actionsClassName,
  eyebrow,
  title,
  titleClassName,
  afterTitle,
  actions,
}: {
  className: string;
  headingClassName: string;
  actionsClassName: string;
  eyebrow: ReactNode;
  title: string;
  titleClassName?: string;
  afterTitle?: ReactNode;
  actions: ReactNode;
}) {
  return (
    <header className={`${className} reader-chrome-header`}>
      <div className={`${headingClassName} reader-chrome-heading`}>
        <span className="reader-chrome-eyebrow">{eyebrow}</span>
        <strong className={titleClassName} title={title}>
          {title}
        </strong>
        {afterTitle}
      </div>
      <div className={`${actionsClassName} reader-chrome-actions`}>
        {actions}
      </div>
    </header>
  );
}
