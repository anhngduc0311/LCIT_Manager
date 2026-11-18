import { formatBytes } from '../models/attachments';
import { Icon } from './icon';
import styles from './sftp-browser.module.css';

type Entry = { name: string; type: string; size?: number; modifyTime?: number };
const dateTime = new Intl.DateTimeFormat('vi-VN', { dateStyle: 'short', timeStyle: 'short' });

export function SftpFileTable<T extends Entry>({ entries, filter, selected, choose, disabled, empty, label }: {
  entries: T[]; filter: string; selected: string | undefined; choose: (entry: T) => void; disabled: boolean; empty: string; label: string;
}) {
  const query = filter.trim().toLocaleLowerCase('vi');
  const visible = entries.filter((entry) => entry.name.toLocaleLowerCase('vi').includes(query))
    .sort((a, b) => Number(b.type === 'd') - Number(a.type === 'd') || a.name.localeCompare(b.name, 'vi', { numeric: true }));
  return <div className={styles.files}>
    <table aria-label={label}>
      <thead><tr><th scope="col">Tên</th><th scope="col">Dung lượng</th><th scope="col">Sửa đổi</th></tr></thead>
      <tbody>{visible.map((entry) => <tr key={entry.name} data-selected={entry.name === selected}>
        <td><button type="button" className={styles.entry} aria-pressed={entry.type === '-' ? entry.name === selected : undefined} disabled={disabled || !['d', '-'].includes(entry.type)} onClick={() => choose(entry)}>
          <span className={entry.type === 'd' ? styles.folderIcon : undefined}><Icon name={entry.type === 'd' ? 'folder' : 'reports'} size={16} /></span>
          <span title={entry.name}>{entry.name}</span>
        </button></td>
        <td>{entry.type === 'l' ? 'Liên kết' : entry.type === 'd' || entry.size === undefined ? '—' : formatBytes(entry.size)}</td>
        <td>{entry.modifyTime === undefined ? '—' : dateTime.format(new Date(entry.modifyTime))}</td>
      </tr>)}</tbody>
    </table>
    {visible.length === 0 && <p className={styles.empty}>{query ? 'Không tìm thấy tệp phù hợp.' : empty}</p>}
  </div>;
}
