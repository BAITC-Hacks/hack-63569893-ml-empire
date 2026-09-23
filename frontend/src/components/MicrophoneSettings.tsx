import { useEffect, useId, useRef, useState } from 'react';
import { Settings, X } from 'lucide-react';

interface MicrophoneSettingsProps {
  language: 'ru' | 'kk';
  devices: MediaDeviceInfo[];
  deviceId: string;
  onDeviceChange: (deviceId: string) => void;
  micMode: 'hold' | 'auto';
  onModeChange: (mode: 'hold' | 'auto') => void;
  disabled: boolean;
  onRefreshDevices: () => Promise<void>;
}

const copy = {
  ru: {
    title: 'Настройки микрофона', close: 'Закрыть настройки микрофона',
    device: 'Микрофон', defaultDevice: 'Системный по умолчанию',
    mode: 'Режим записи', hold: 'Удерживать кнопку', auto: 'Завершать после тишины',
    refresh: 'Обновить устройства',
    help: 'Имена устройств появятся после разрешения доступа. Определение тишины работает локально; шум может помешать. Реплику всегда можно завершить вручную.',
  },
  kk: {
    title: 'Микрофон баптаулары', close: 'Микрофон баптауларын жабу',
    device: 'Микрофон', defaultDevice: 'Жүйелік әдепкі',
    mode: 'Жазу режимі', hold: 'Батырманы басып тұру', auto: 'Тыныштықтан кейін аяқтау',
    refresh: 'Құрылғыларды жаңарту',
    help: 'Құрылғы атаулары рұқсат берілгеннен кейін көрінеді. Тыныштық жергілікті анықталады; шу кедергі болуы мүмкін. Репликаны қолмен аяқтауға болады.',
  },
};

export function MicrophoneSettings({
  language, devices, deviceId, onDeviceChange, micMode, onModeChange,
  disabled, onRefreshDevices,
}: MicrophoneSettingsProps) {
  const t = copy[language];
  const id = useId();
  const dialogId = `${id}-mic-settings`;
  const titleId = `${id}-mic-settings-title`;
  const helpId = `${id}-mic-settings-help`;
  const dialogRef = useRef<HTMLDialogElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const mountedRef = useRef(false);
  const backdropPointerRef = useRef<number | null>(null);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    mountedRef.current = true;
    const dialog = dialogRef.current;
    return () => {
      mountedRef.current = false;
      backdropPointerRef.current = null;
      if (dialog?.open) dialog.close();
    };
  }, []);

  function openSettings() {
    const dialog = dialogRef.current;
    if (!dialog || dialog.open) return;
    dialog.showModal();
    setOpen(true);
  }

  function closeSettings() {
    backdropPointerRef.current = null;
    dialogRef.current?.close();
  }

  function isOutsideDialog(clientX: number, clientY: number) {
    const rect = dialogRef.current?.getBoundingClientRect();
    return Boolean(rect && (clientX < rect.left || clientX > rect.right || clientY < rect.top || clientY > rect.bottom));
  }

  return <>
    <button
      ref={triggerRef} type="button" className="mic-settings-trigger"
      aria-label={t.title} title={t.title} aria-haspopup="dialog"
      aria-expanded={open} aria-controls={dialogId} onClick={openSettings}
    ><Settings size={18} aria-hidden="true" /></button>
    <dialog
      ref={dialogRef} id={dialogId} className="mic-settings-dialog"
      aria-labelledby={titleId} aria-describedby={helpId}
      onClose={() => {
        if (!mountedRef.current || dialogRef.current?.open) return;
        backdropPointerRef.current = null;
        setOpen(false);
        if (triggerRef.current?.isConnected) triggerRef.current.focus({ preventScroll: true });
      }}
      onPointerDown={event => {
        backdropPointerRef.current = event.button === 0 && event.target === event.currentTarget && isOutsideDialog(event.clientX, event.clientY) ? event.pointerId : null;
      }}
      onPointerUp={event => {
        const startedOnBackdrop = backdropPointerRef.current === event.pointerId;
        backdropPointerRef.current = null;
        if (startedOnBackdrop && event.target === event.currentTarget && isOutsideDialog(event.clientX, event.clientY)) closeSettings();
      }}
      onPointerCancel={() => { backdropPointerRef.current = null; }}
    >
      <div className="mic-settings-heading">
        <h2 id={titleId}>{t.title}</h2>
        <button type="button" className="mic-settings-close" onClick={closeSettings} aria-label={t.close} title={t.close} autoFocus><X size={20} aria-hidden="true" /></button>
      </div>
      <div className="mic-settings-fields">
        <label>{t.device}<select disabled={disabled} value={deviceId} onChange={event => onDeviceChange(event.target.value)}>
          <option value="">{t.defaultDevice}</option>
          {devices.filter(device => device.deviceId && device.deviceId !== 'default').map((device, index) => <option key={device.deviceId} value={device.deviceId}>{device.label || `${t.device} ${index + 1}`}</option>)}
        </select></label>
        <label>{t.mode}<select disabled={disabled} value={micMode} onChange={event => onModeChange(event.target.value as 'hold' | 'auto')}>
          <option value="hold">{t.hold}</option><option value="auto">{t.auto}</option>
        </select></label>
      </div>
      <button type="button" className="mic-settings-refresh" onClick={() => void onRefreshDevices()}>{t.refresh}</button>
      <p id={helpId} className="mic-settings-help">{t.help}</p>
    </dialog>
  </>;
}
