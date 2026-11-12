import { CSSProperties } from 'react';
const paths: Record<string, string> = {
 search: 'm21 21-4.5-4.5 M19 10.5a8.5 8.5 0 1 1-17 0 8.5 8.5 0 0 1 17 0',
 applications: 'M3 3h7v7H3z M14 3h7v7h-7z M3 14h7v7H3z M14 14h7v7h-7z',
 servers: 'M3 3h18v7H3z M3 14h18v7H3z M7 6.5h.01 M7 17.5h.01 M11 6.5h6 M11 17.5h6',
 domains: 'M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0 M3 12h18 M12 3c-5 5-5 13 0 18 M12 3c5 5 5 13 0 18',
 databases: 'M20 6c0 2-3.6 3-8 3S4 8 4 6s3.6-3 8-3 8 1 8 3 M4 6v12c0 2 3.6 3 8 3s8-1 8-3V6 M4 12c0 2 3.6 3 8 3s8-1 8-3',
 organizations: 'M4 21V7h10v14 M14 11h6v10 M2 21h20 M8 11h2 M8 15h2 M8 3h2v4',
 'data-centers': 'M3 21V3h18v18 M1 21h22 M7 7h2 M15 7h2 M7 11h2 M15 11h2 M10 21v-6h4v6',
 users: 'M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2 M13 7a4 4 0 1 1-8 0 4 4 0 0 1 8 0 M22 21v-2a4 4 0 0 0-3-3.9 M17 3.1a4 4 0 0 1 0 7.8',
 health: 'M3 12h4l3-8 4 16 3-8h4', logout: 'M9 21H3V3h6 M9 12h12 M17 8l4 4-4 4',
 arrow: 'M4 12h16 M14 6l6 6-6 6', shield: 'm12 3 8 3v6c0 5-8 9-8 9s-8-4-8-9V6z M8 12l3 3 5-6',
};
export function Icon({ name, size = 20, style }: { name: string; size?: number; style?: CSSProperties }) {
 return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" style={style}><path d={paths[name] ?? paths.applications} /></svg>;
}
