import { useState } from 'react';
import { Page, RequestApi } from '../models/api';
import {
  AccessEndpoint, AccessGrant, LaunchReport,
} from '../models/access';
import { inTauri } from '../models/tauri';
import { errorText, useRemote } from './use-remote';

export function useEndpoints(api: RequestApi, serverId: string) {
  const [revision, setRevision] = useState(0);
  const result = useRemote<Page<AccessEndpoint>>(api, serverId ? `/servers/${serverId}/access-endpoints?pageSize=100` : '', revision);
  return { result, reload: () => setRevision((value) => value + 1) };
}

/**
 * Open the SSH/RDP login UI. Its Connect action obtains a fresh API authorization before opening a session.
 * Outside Tauri no authorization is requested because native sessions cannot be opened.
 */
export function useLaunch(api: RequestApi) {
  const [busy, setBusy] = useState('');
  const [terminal, setTerminal] = useState<AccessEndpoint>();
  const [rdp, setRdp] = useState<AccessEndpoint>();
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
      setRdp(endpoint);
    } catch (failure) {
      setReport({ endpointId: endpoint.id, tone: 'error', text: errorText(failure) });
    } finally {
      setBusy('');
    }
  }

  return { launch, busy, report, terminal, closeTerminal: () => setTerminal(undefined), rdp, closeRdp: () => setRdp(undefined) };
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
