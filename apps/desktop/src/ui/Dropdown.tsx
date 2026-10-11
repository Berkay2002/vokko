import { useEffect, useId, useLayoutEffect, useRef, useState, type KeyboardEvent } from "react";
import { createPortal } from "react-dom";
import { ChevronDown, type LucideIcon } from "lucide-react";
import { useLayer } from "./layers";
import { placeNear } from "./position";
import "./dropdown.css";

export interface DropdownOption<T extends string = string> {
  value: T;
  label: string;
  /** Greyed text after the label, shown in parentheses (a device's driver or group name). */
  detail?: string;
}

export interface DropdownProps<T extends string = string> {
  label: string;
  value: T;
  options: DropdownOption<T>[];
  onChange(next: T): void;
  disabled?: boolean;
  /** Drawn left of the label in the trigger and in every option. */
  icon?: LucideIcon;
  /** Extra class on the wrapper. */
  className?: string;
  /** Class for the trigger's box; defaults to `dropdown-box`. Layout (icon left, chevron right) always comes from `dropdown-trigger`. */
  triggerClassName?: string;
}

const GAP = 4;

/**
 * Custom listbox dropdown (Discord's dark picker) in place of a native <select>: options can carry an icon and a greyed
 * detail. The list is portalled with fixed positioning, so a modal's or a scroller's overflow cannot clip it. It goes into
 * the nearest aria-modal dialog (falling back to <body>): outside it, screen readers treat the list as hidden.
 */
export function Dropdown<T extends string = string>({ label, value, options, onChange, disabled, icon: Icon, className, triggerClassName = "dropdown-box" }: DropdownProps<T>) {
  const id = useId();
  const listId = `${id}-list`;
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const [pos, setPos] = useState<{ left: number; top: number; width: number } | null>(null);
  const [host, setHost] = useState<HTMLElement | null>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const list = useRef<HTMLUListElement>(null);
  const found = options.findIndex(o => o.value === value);
  const selected = Math.max(0, found);
  const current = options[selected];

  const close = (refocus: boolean) => {
    setOpen(false);
    if (refocus) trigger.current?.focus();
  };

  // Escape closes this list only, not the modal or popout underneath.
  useLayer(open, () => close(true));

  useEffect(() => {
    if (!open) return;
    list.current?.focus({ preventScroll: true });
    const onDown = (event: PointerEvent) => {
      const target = event.target as Node;
      // Close after this press's mousedown: until then the list stays the top layer, so a modal backdrop ignores the press.
      if (!trigger.current?.contains(target) && !list.current?.contains(target)) window.setTimeout(() => setOpen(false), 0);
    };
    document.addEventListener("pointerdown", onDown, true);
    return () => document.removeEventListener("pointerdown", onDown, true);
  }, [open]);

  useLayoutEffect(() => {
    if (!open) {
      setPos(null);
      return;
    }
    const place = () => {
      const anchor = trigger.current?.getBoundingClientRect();
      const el = list.current;
      if (!anchor || !el) return;
      const { left, top } = placeNear(anchor, anchor.width, el.offsetHeight, "bottom", GAP, "start");
      setPos({ left, top, width: anchor.width });
    };
    place();
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    return () => {
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", place, true);
    };
  }, [open, options.length]);

  useEffect(() => {
    if (open) document.getElementById(`${id}-${active}`)?.scrollIntoView({ block: "nearest" });
  }, [open, active, id]);

  const show = () => {
    setActive(selected);
    setHost(trigger.current?.closest<HTMLElement>('[aria-modal="true"]') ?? document.body);
    setOpen(true);
  };
  const choose = (index: number) => {
    const option = options[index];
    if (option && option.value !== value) onChange(option.value);
    close(true);
  };
  const onListKey = (event: KeyboardEvent) => {
    if (event.key === "ArrowDown") setActive(a => Math.min(options.length - 1, a + 1));
    else if (event.key === "ArrowUp") setActive(a => Math.max(0, a - 1));
    else if (event.key === "Home") setActive(0);
    else if (event.key === "End") setActive(options.length - 1);
    else if (event.key === "Enter" || event.key === " ") choose(active);
    else if (event.key === "Escape") close(true);
    else if (event.key === "Tab") {
      // Hand focus back to the trigger and let the browser (or the modal's focus trap) move on from there.
      close(true);
      return;
    } else return;
    event.preventDefault();
    event.stopPropagation();
  };

  return (
    <div className={`dropdown${className ? ` ${className}` : ""}`}>
      <button
        ref={trigger}
        type="button"
        role="combobox"
        className={`dropdown-trigger ${triggerClassName}`}
        aria-label={label}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? listId : undefined}
        disabled={disabled}
        onClick={() => (open ? setOpen(false) : show())}
        onKeyDown={event => {
          if (!open && (event.key === "ArrowDown" || event.key === "ArrowUp")) {
            event.preventDefault();
            show();
          }
        }}
      >
        {Icon && <Icon size={18} aria-hidden className="dropdown-icon" />}
        <span className="dropdown-name">{current?.label ?? ""}</span>
        {current?.detail && <span className="dropdown-detail">({current.detail})</span>}
        <ChevronDown size={18} aria-hidden className="dropdown-chevron" />
      </button>
      {open &&
        host &&
        createPortal(
          <ul
            ref={list}
            id={listId}
            className="dropdown-list"
            role="listbox"
            tabIndex={-1}
            aria-label={label}
            aria-activedescendant={options.length ? `${id}-${active}` : undefined}
            onKeyDown={onListKey}
            style={{ left: pos?.left ?? 0, top: pos?.top ?? 0, width: pos?.width, visibility: pos ? "visible" : "hidden" }}
          >
            {options.map((o, i) => (
              <li
                key={o.value}
                id={`${id}-${i}`}
                role="option"
                aria-selected={i === found}
                className={`dropdown-option${i === active ? " active" : ""}${i === found ? " selected" : ""}`}
                onPointerEnter={() => setActive(i)}
                onClick={() => choose(i)}
              >
                {Icon && <Icon size={16} aria-hidden className="dropdown-icon" />}
                <span className="dropdown-name">{o.label}</span>
                {o.detail && <span className="dropdown-detail">({o.detail})</span>}
              </li>
            ))}
          </ul>,
          host,
        )}
    </div>
  );
}
