export type AppIconName =
  | 'fit'
  | 'minus'
  | 'plus'
  | 'collapse'
  | 'expand'
  | 'sun'
  | 'moon'
  | 'compass'
  | 'sparkle';

export function Icon({ name }: { name: AppIconName }) {
  if (name === 'fit') {
    return (
      <svg viewBox="0 0 16 16" aria-hidden="true">
        <path d="M2 6V2h4M10 2h4v4M14 10v4h-4M6 14H2v-4M2 2l4 4m8-4-4 4m4 8-4-4m-8 4 4-4" />
      </svg>
    );
  }
  if (name === 'collapse' || name === 'expand') {
    return (
      <svg viewBox="0 0 16 16" aria-hidden="true">
        <path d="m9.5 3-5 5 5 5" />
      </svg>
    );
  }
  if (name === 'moon') {
    return (
      <svg viewBox="0 0 16 16" aria-hidden="true">
        <path d="M13.3 10.5A5.8 5.8 0 0 1 5.5 2.7 5.9 5.9 0 1 0 13.3 10.5Z" />
      </svg>
    );
  }
  if (name === 'sun') {
    return (
      <svg viewBox="0 0 16 16" aria-hidden="true">
        <circle cx="8" cy="8" r="3" />
        <path d="M8 1.5v1.4M8 13.1v1.4M1.5 8h1.4M13.1 8h1.4m-11.1-4 1 1m6.2 6.2 1 1m0-8.2-1 1m-6.2 6.2-1 1" />
      </svg>
    );
  }
  if (name === 'compass') {
    return (
      <svg
        viewBox="0 0 16 16"
        aria-hidden="true"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.2"
      >
        <circle cx="8" cy="8" r="6.2" />
        <path d="m11 5-4.5 2-2 4.5 4.5-2z" fill="currentColor" />
      </svg>
    );
  }
  if (name === 'sparkle') {
    return (
      <svg viewBox="0 0 16 16" aria-hidden="true" fill="currentColor">
        <path d="M8 1.5c.3 2 .8 3.5 2 4.5 1.2 1 2.7 1.5 4.5 2-1.8.5-3.3 1-4.5 2-1.2 1-1.7 2.5-2 4.5-.3-2-.8-3.5-2-4.5-1.2-1-2.7-1.5-4.5-2 1.8-.5 3.3-1 4.5-2 1.2-1 1.7-2.5 2-4.5Z" />
      </svg>
    );
  }
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true">
      <path d={name === 'plus' ? 'M8 3v10M3 8h10' : 'M3 8h10'} />
    </svg>
  );
}

export default Icon;
