import type { ReactNode } from 'react';

type PageHeadingProps = {
  id?: string;
  title: string;
  subtitle: string;
  actions?: ReactNode;
};

export function PageHeading({ id, title, subtitle, actions }: PageHeadingProps) {
  return <header className="page-intro">
    <div><h1 id={id}>{title}</h1><p>{subtitle}</p></div>
    {actions}
  </header>;
}
