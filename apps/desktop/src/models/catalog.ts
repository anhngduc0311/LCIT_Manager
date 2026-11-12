export const catalogKinds = ['applications', 'servers', 'domains', 'databases', 'organizations', 'data-centers', 'users'] as const;
export type Kind = typeof catalogKinds[number];

export interface SearchResult {
  id: string; name: string; code: string;
  organization: { id: string; name: string };
  owner: { id: string; displayName: string } | null;
  servers: { id: string; hostname: string; dataCenter: { id: string; name: string };
    addresses: { address: string; networkScope: string; kind: string }[]; accessMethods: string[] }[];
  domains: { id: string; name: string }[];
}
