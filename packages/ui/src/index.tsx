/**
 * packages/ui — Radix-based primitives, heavily customised (REQUIREMENT 130, 131).
 *
 * Deliberately not "dashboard cards": these are dense workbench controls sized
 * for a tool rail and an inspector. All of them are keyboard reachable, have
 * visible focus rings, and honour prefers-reduced-motion (HARDENING CHECK 010).
 */
import * as React from 'react';
import * as SliderPrimitive from '@radix-ui/react-slider';
import * as SwitchPrimitive from '@radix-ui/react-switch';
import * as PopoverPrimitive from '@radix-ui/react-popover';
import * as DialogPrimitive from '@radix-ui/react-dialog';
import * as TooltipPrimitive from '@radix-ui/react-tooltip';
import * as SelectPrimitive from '@radix-ui/react-select';
import * as ToggleGroupPrimitive from '@radix-ui/react-toggle-group';
import * as SeparatorPrimitive from '@radix-ui/react-separator';

export const cx = (...parts: Array<string | false | null | undefined>): string =>
  parts.filter(Boolean).join(' ');

/* ----------------------------------------------------------------- button --- */

export interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: 'primary' | 'secondary' | 'ghost' | 'danger' | 'subtle';
  size?: 'xs' | 'sm' | 'md';
  active?: boolean;
}

export const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { className, variant = 'secondary', size = 'sm', active, type = 'button', ...props },
  ref,
) {
  return (
    <button
      ref={ref}
      type={type}
      data-variant={variant}
      data-active={active ? 'true' : undefined}
      className={cx('ui-btn', `ui-btn--${variant}`, `ui-btn--${size}`, className)}
      {...props}
    />
  );
});

export interface IconButtonProps extends ButtonProps {
  label: string;
}

export const IconButton = React.forwardRef<HTMLButtonElement, IconButtonProps>(function IconButton(
  { label, className, children, ...props },
  ref,
) {
  return (
    <Button ref={ref} aria-label={label} title={label} className={cx('ui-icon-btn', className)} {...props}>
      {children}
    </Button>
  );
});

/* ----------------------------------------------------------------- slider --- */

export interface SliderProps {
  value: number;
  onValueChange: (v: number) => void;
  min?: number;
  max?: number;
  step?: number;
  label: string;
  format?: (v: number) => string;
  disabled?: boolean;
  id?: string;
}

export function Slider({ value, onValueChange, min = 0, max = 100, step = 1, label, format, disabled, id }: SliderProps) {
  const shown = format ? format(value) : String(Math.round(value * 100) / 100);
  return (
    <div className="ui-field">
      <div className="ui-field__head">
        <label className="ui-label" htmlFor={id}>{label}</label>
        <span className="ui-value">{shown}</span>
      </div>
      <SliderPrimitive.Root
        id={id}
        className="ui-slider"
        value={[value]}
        min={min}
        max={max}
        step={step}
        disabled={disabled}
        onValueChange={(v) => onValueChange(v[0])}
        aria-label={label}
      >
        <SliderPrimitive.Track className="ui-slider__track">
          <SliderPrimitive.Range className="ui-slider__range" />
        </SliderPrimitive.Track>
        <SliderPrimitive.Thumb className="ui-slider__thumb" aria-label={label} />
      </SliderPrimitive.Root>
    </div>
  );
}

/* ------------------------------------------------------- scrubbable number --- */

export interface NumberScrubProps {
  value: number;
  onChange: (v: number) => void;
  label: string;
  min?: number;
  max?: number;
  step?: number;
  precision?: number;
  suffix?: string;
  disabled?: boolean;
}

/** Drag horizontally to scrub, click to type (REQUIREMENT 131). */
export function NumberScrub({ value, onChange, label, min = -1e6, max = 1e6, step = 0.1, precision = 2, suffix, disabled }: NumberScrubProps) {
  const [editing, setEditing] = React.useState(false);
  const [draft, setDraft] = React.useState(String(value));
  const dragRef = React.useRef<{ startX: number; startValue: number } | null>(null);

  React.useEffect(() => setDraft(String(value)), [value]);

  const commit = (raw: string) => {
    const n = Number(raw);
    if (Number.isFinite(n)) onChange(Math.max(min, Math.min(max, n)));
    else setDraft(String(value));
    setEditing(false);
  };

  const onPointerDown = (e: React.PointerEvent) => {
    if (disabled || editing) return;
    dragRef.current = { startX: e.clientX, startValue: value };
    (e.target as Element).setPointerCapture?.(e.pointerId);
    e.preventDefault();
  };
  const onPointerMove = (e: React.PointerEvent) => {
    if (!dragRef.current) return;
    const dx = e.clientX - dragRef.current.startX;
    const next = dragRef.current.startValue + dx * step;
    onChange(Math.max(min, Math.min(max, Number(next.toFixed(precision)))));
  };
  const onPointerUp = () => {
    dragRef.current = null;
  };

  return (
    <div className="ui-field ui-field--inline">
      <span className="ui-label ui-scrub__label" onDoubleClick={() => !disabled && setEditing(true)}>
        {label}
      </span>
      {editing ? (
        <input
          className="ui-input ui-scrub__input"
          autoFocus
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={(e) => commit(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') commit((e.target as HTMLInputElement).value);
            if (e.key === 'Escape') setEditing(false);
          }}
          inputMode="decimal"
        />
      ) : (
        <button
          type="button"
          className="ui-scrub"
          disabled={disabled}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onDoubleClick={() => setEditing(true)}
          title={`${label} — drag to scrub, double-click to type`}
          aria-label={`${label}: ${value}${suffix ?? ''}`}
        >
          {value.toFixed(precision)}
          {suffix ? <span className="ui-scrub__suffix">{suffix}</span> : null}
        </button>
      )}
    </div>
  );
}

/* --------------------------------------------------------- segmented group --- */

export interface SegmentedOption<T extends string> {
  value: T;
  label: string;
  title?: string;
}

export interface SegmentedProps<T extends string> {
  value: T;
  onChange: (v: T) => void;
  options: Array<SegmentedOption<T>>;
  label: string;
  size?: 'xs' | 'sm';
  disabled?: boolean;
}

export function Segmented<T extends string>({ value, onChange, options, label, size = 'sm', disabled }: SegmentedProps<T>) {
  return (
    <div className="ui-field">
      <span className="ui-label">{label}</span>
      <ToggleGroupPrimitive.Root
        type="single"
        value={value}
        onValueChange={(v) => v && onChange(v as T)}
        className={cx('ui-segmented', `ui-segmented--${size}`)}
        aria-label={label}
        disabled={disabled}
      >
        {options.map((o) => (
          <ToggleGroupPrimitive.Item key={o.value} value={o.value} className="ui-segmented__item" title={o.title ?? o.label} aria-label={o.label}>
            {o.label}
          </ToggleGroupPrimitive.Item>
        ))}
      </ToggleGroupPrimitive.Root>
    </div>
  );
}

/* ----------------------------------------------------------------- switch --- */

export interface SwitchProps {
  checked: boolean;
  onChange: (v: boolean) => void;
  label: string;
  description?: string;
  disabled?: boolean;
  id?: string;
}

export function Switch({ checked, onChange, label, description, disabled, id }: SwitchProps) {
  return (
    <div className="ui-field ui-field--row">
      <div className="ui-field__text">
        <label className="ui-label" htmlFor={id}>{label}</label>
        {description ? <span className="ui-hint">{description}</span> : null}
      </div>
      <SwitchPrimitive.Root id={id} className="ui-switch" checked={checked} onCheckedChange={onChange} disabled={disabled} aria-label={label}>
        <SwitchPrimitive.Thumb className="ui-switch__thumb" />
      </SwitchPrimitive.Root>
    </div>
  );
}

/* ----------------------------------------------------------------- select --- */

export interface SelectOption {
  value: string;
  label: string;
  disabled?: boolean;
}

export interface SelectProps {
  value: string;
  onChange: (v: string) => void;
  options: SelectOption[];
  label: string;
  placeholder?: string;
  disabled?: boolean;
}

export function Select({ value, onChange, options, label, placeholder, disabled }: SelectProps) {
  return (
    <div className="ui-field">
      <span className="ui-label">{label}</span>
      <SelectPrimitive.Root value={value} onValueChange={onChange} disabled={disabled}>
        <SelectPrimitive.Trigger className="ui-select__trigger" aria-label={label}>
          <SelectPrimitive.Value placeholder={placeholder ?? 'Select…'} />
          <SelectPrimitive.Icon className="ui-select__icon">▾</SelectPrimitive.Icon>
        </SelectPrimitive.Trigger>
        <SelectPrimitive.Portal>
          <SelectPrimitive.Content className="ui-select__content" position="popper" sideOffset={4}>
            <SelectPrimitive.Viewport>
              {options.map((o) => (
                <SelectPrimitive.Item key={o.value} value={o.value} disabled={o.disabled} className="ui-select__item">
                  <SelectPrimitive.ItemText>{o.label}</SelectPrimitive.ItemText>
                </SelectPrimitive.Item>
              ))}
            </SelectPrimitive.Viewport>
          </SelectPrimitive.Content>
        </SelectPrimitive.Portal>
      </SelectPrimitive.Root>
    </div>
  );
}

/* ---------------------------------------------------------------- popover --- */

export interface PopoverProps {
  trigger: React.ReactNode;
  children: React.ReactNode;
  label: string;
  side?: 'top' | 'bottom' | 'left' | 'right';
  align?: 'start' | 'center' | 'end';
  onOpenChange?: (open: boolean) => void;
  open?: boolean;
  /** Register as a blocking overlay so map movement stops (REQ 025). */
  blocking?: boolean;
  width?: number;
}

export function Popover({ trigger, children, label, side = 'bottom', align = 'end', onOpenChange, open, blocking = true, width = 260 }: PopoverProps) {
  return (
    <PopoverPrimitive.Root open={open} onOpenChange={onOpenChange}>
      <PopoverPrimitive.Trigger asChild>{trigger}</PopoverPrimitive.Trigger>
      <PopoverPrimitive.Portal>
        <PopoverPrimitive.Content
          className="ui-popover"
          side={side}
          align={align}
          sideOffset={6}
          aria-label={label}
          data-blocking-overlay={blocking ? 'true' : undefined}
          data-open={open === undefined ? undefined : open ? 'true' : 'false'}
          style={{ width }}
          onOpenAutoFocus={(e) => e.preventDefault()}
        >
          {children}
        </PopoverPrimitive.Content>
      </PopoverPrimitive.Portal>
    </PopoverPrimitive.Root>
  );
}

/* ------------------------------------------------------------------ modal --- */

export interface ModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description?: string;
  children: React.ReactNode;
  footer?: React.ReactNode;
  width?: number;
}

export function Modal({ open, onOpenChange, title, description, children, footer, width = 460 }: ModalProps) {
  return (
    <DialogPrimitive.Root open={open} onOpenChange={onOpenChange}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="ui-modal__overlay" data-blocking-overlay="true" data-open={open ? 'true' : 'false'} />
        <DialogPrimitive.Content
          className="ui-modal"
          style={{ width }}
          aria-describedby={description ? undefined : undefined}
          data-blocking-overlay="true"
          data-open={open ? 'true' : 'false'}
        >
          <DialogPrimitive.Title className="ui-modal__title">{title}</DialogPrimitive.Title>
          {description ? <DialogPrimitive.Description className="ui-modal__desc">{description}</DialogPrimitive.Description> : null}
          <div className="ui-modal__body" data-scroll-region="true">{children}</div>
          {footer ? <div className="ui-modal__footer">{footer}</div> : null}
          <DialogPrimitive.Close asChild>
            <button className="ui-modal__close" aria-label="Close dialog">✕</button>
          </DialogPrimitive.Close>
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}

/* ---------------------------------------------------------------- tooltip --- */

export function TooltipProvider({ children }: { children: React.ReactNode }) {
  return (
    <TooltipPrimitive.Provider delayDuration={350} skipDelayDuration={200}>
      {children}
    </TooltipPrimitive.Provider>
  );
}

export function Tooltip({ label, children, side = 'right' }: { label: string; children: React.ReactNode; side?: 'top' | 'bottom' | 'left' | 'right' }) {
  return (
    <TooltipPrimitive.Root>
      <TooltipPrimitive.Trigger asChild>{children}</TooltipPrimitive.Trigger>
      <TooltipPrimitive.Portal>
        <TooltipPrimitive.Content className="ui-tooltip" side={side} sideOffset={6}>
          {label}
        </TooltipPrimitive.Content>
      </TooltipPrimitive.Portal>
    </TooltipPrimitive.Root>
  );
}

/* -------------------------------------------------------------- separator --- */

export function Separator({ orientation = 'horizontal', label }: { orientation?: 'horizontal' | 'vertical'; label?: string }) {
  if (label) {
    return (
      <div className="ui-section-label" role="presentation">
        {label}
      </div>
    );
  }
  return <SeparatorPrimitive.Root className="ui-separator" orientation={orientation} decorative />;
}

/* ------------------------------------------------------------------- text --- */

export interface TextFieldProps {
  value: string;
  onChange: (v: string) => void;
  label: string;
  placeholder?: string;
  type?: string;
  disabled?: boolean;
  hint?: string;
  invalid?: string | null;
  id?: string;
}

export function TextField({ value, onChange, label, placeholder, type = 'text', disabled, hint, invalid, id }: TextFieldProps) {
  const inputId = id ?? `ui-field-${label.replace(/\W+/g, '-').toLowerCase()}`;
  return (
    <div className="ui-field">
      <label className="ui-label" htmlFor={inputId}>{label}</label>
      <input
        id={inputId}
        className={cx('ui-input', invalid && 'ui-input--invalid')}
        value={value}
        type={type}
        placeholder={placeholder}
        disabled={disabled}
        aria-invalid={invalid ? 'true' : undefined}
        aria-describedby={invalid ? `${inputId}-err` : undefined}
        onChange={(e) => onChange(e.target.value)}
      />
      {invalid ? (
        <span id={`${inputId}-err`} className="ui-error" role="alert">{invalid}</span>
      ) : hint ? (
        <span className="ui-hint">{hint}</span>
      ) : null}
    </div>
  );
}

export interface TextAreaProps {
  value: string;
  onChange: (v: string) => void;
  label: string;
  rows?: number;
  placeholder?: string;
  disabled?: boolean;
}

export function TextArea({ value, onChange, label, rows = 4, placeholder, disabled }: TextAreaProps) {
  return (
    <div className="ui-field">
      <label className="ui-label">{label}</label>
      <textarea className="ui-input ui-textarea" rows={rows} value={value} placeholder={placeholder} disabled={disabled} onChange={(e) => onChange(e.target.value)} aria-label={label} />
    </div>
  );
}

/* ------------------------------------------------------------------ panel --- */

export interface PanelProps {
  title: string;
  children: React.ReactNode;
  actions?: React.ReactNode;
  collapsed?: boolean;
  onCollapsedChange?: (v: boolean) => void;
  /** Panel identifier used by the tutorial spotlight. */
  panelId?: string;
}

export function Panel({ title, children, actions, collapsed, onCollapsedChange, panelId }: PanelProps) {
  const [internal, setInternal] = React.useState(false);
  const isCollapsed = collapsed ?? internal;
  const setCollapsed = (v: boolean) => {
    setInternal(v);
    onCollapsedChange?.(v);
  };
  return (
    <section className="ui-panel" data-panel={panelId} data-collapsed={isCollapsed ? 'true' : 'false'}>
      <header
        className="ui-panel__header"
        data-drag-handle="panel-header"
        onDoubleClick={() => setCollapsed(!isCollapsed)}
      >
        <button
          type="button"
          className="ui-panel__toggle"
          aria-expanded={!isCollapsed}
          aria-label={`${isCollapsed ? 'Expand' : 'Collapse'} ${title}`}
          onClick={() => setCollapsed(!isCollapsed)}
        >
          {isCollapsed ? '▸' : '▾'}
        </button>
        <h3 className="ui-panel__title">{title}</h3>
        <div className="ui-panel__actions">{actions}</div>
      </header>
      {!isCollapsed ? (
        <div className="ui-panel__body" data-scroll-region="true">
          {children}
        </div>
      ) : null}
    </section>
  );
}

/* ------------------------------------------------------------------ badges --- */

export function Badge({ tone = 'neutral', children }: { tone?: 'neutral' | 'ok' | 'warn' | 'error' | 'info'; children: React.ReactNode }) {
  return <span className={cx('ui-badge', `ui-badge--${tone}`)}>{children}</span>;
}

export function StatRow({ label, value, tone }: { label: string; value: React.ReactNode; tone?: 'ok' | 'warn' | 'error' }) {
  return (
    <div className="ui-stat">
      <span className="ui-stat__label">{label}</span>
      <span className={cx('ui-stat__value', tone && `ui-stat__value--${tone}`)}>{value}</span>
    </div>
  );
}

/** Inline, dismissible error surface (REQUIREMENT: errors are visible and actionable). */
export function ErrorBanner({ message, onRetry, onDismiss, actionLabel = 'Retry' }: { message: string; onRetry?: () => void; onDismiss?: () => void; actionLabel?: string }) {
  if (!message) return null;
  return (
    <div className="ui-error-banner" role="alert">
      <span className="ui-error-banner__text">{message}</span>
      <span className="ui-error-banner__actions">
        {onRetry ? <Button size="xs" variant="danger" onClick={onRetry}>{actionLabel}</Button> : null}
        {onDismiss ? <Button size="xs" variant="ghost" onClick={onDismiss}>Dismiss</Button> : null}
      </span>
    </div>
  );
}
