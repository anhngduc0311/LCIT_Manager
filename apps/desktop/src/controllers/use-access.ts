import { useState } from 'react';
import { Page, RequestApi } from '../models/api';
import {
  AccessEndpoint, AccessGrant, AccessLaunchResponse, describeOutcome, LaunchOutcome, LaunchReport,
} from '../models/access';
import { inTauri } from '../models/tauri';
import { errorText, useRemote } from './use-remote';

export function useEndpoints(api: RequestApi, serverId: string) {
  const [revision, setRevision] = useState(0);
  const result = useRemote<Page<AccessEndpoint>>(api, serverId ? `/servers/${serverId}/access-endpoints?pageSize=100` : '', revision);
  return { result, reload: () => setRevision((value) => value + 1) };
}

/**
 * One click = one authorization. The API checks the grant and audits the decision; only its answer is used to
 * open the client, never a value typed or cached in the UI. Outside Tauri nothing is requested, so the audit
 * log never records an authorization for a connection that cannot open.
 */
export function useLaunch(api: RequestApi) {
  const [busy, setBusy] = useState('');
  const [terminal, setTerminal] = useState<AccessEndpoint>();
  const [report, setReport] = useState<LaunchReport & { endpointId: string }>();

  async function launch(endpoint: AccessEndpoint) {
    if (busy) return;
    setBusy(endpoint.id); setReport(undefined);
    try {
      if (!inTauri()) {
        setReport({ endpointId: endpoint.id, tone: 'warn', text: 'SSH/RDP chỉ mở được trong ứng dụng LCIT Manager trên Windows, không mở được từ trình duyệt.' });
        return;
      }
      if (endpoint.protocol === 'ssh') { setTerminal(endpoint); return; }
      const grant = await api<AccessLaunchResponse>(`/access-endpoints/${endpoint.id}/launch`, { method: 'POST' });
      const { invoke } = await import('@tauri-apps/api/core');
      const outcome = await invoke<LaunchOutcome>('launch_access', {
        request: { authorizationId: grant.authorizationId, protocol: grant.protocol, host: grant.host, port: grant.port },
      });
      setReport({ endpointId: endpoint.id, ...describeOutcome(outcome, grant), reference: grant.authorizationId.slice(0, 8) });
    } catch (failure) {
      setReport({ endpointId: endpoint.id, tone: 'error', text: errorText(failure) });
    } finally {
      setBusy('');
    }
  }

  return { launch, busy, report, terminal, closeTerminal: () => setTerminal(undefined) };
}

export function useGrants(api: RequestApi, userId: string) {
  const [revision, setRevision] = useState(0);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const result = useRemote<Page<AccessGrant>>(api, `/users/${userId}/access-endpoints?pageSize=100`, revision);

  async function change(endpointId: string, grant: boolean) {
    if (busy) return false;
    setBusy(endpointId); setError('');
    try {
      await api(`/users/${userId}/access-endpoints/${endpointId}`, { method: grant ? 'PUT' : 'DELETE' });
      setRevision((value) => value + 1);
      return true;
    } catch (failure) {
      setError(errorText(failure));
      return false;
    } finally {
      setBusy('');
    }
  }

  return { result, busy, error, grant: (endpointId: string) => change(endpointId, true), revoke: (endpointId: string) => change(endpointId, false) };
}
