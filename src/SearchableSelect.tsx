import { useEffect, useId, useRef, useState } from "react";
import { Search } from "lucide-react";
import { uppercaseText } from "./lib/uppercase";

type Option = { value: string; label: string; keywords?: string };
export default function SearchableSelect({
  label,
  value,
  options,
  onChange,
  disabled = false,
  placeholder = "",
  unmatched = "",
}: {
  label: string;
  value: string;
  options: Option[];
  onChange: (value: string) => void;
  disabled?: boolean;
  placeholder?: string;
  unmatched?: string;
}) {
  const id = useId();
  const root = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const [expanded, setExpanded] = useState(false);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(-1);
  const selected = options.find((option) => option.value === value);
  const normalized = query.trim().toLocaleLowerCase();
  const filtered = options.filter((option) =>
    `${option.label} ${option.keywords || ""}`
      .toLocaleLowerCase()
      .includes(normalized),
  );
  useEffect(() => {
    if (!expanded) return;
    const outside = (event: PointerEvent) => {
      if (event.target instanceof Node && !root.current?.contains(event.target))
        setExpanded(false);
    };
    document.addEventListener("pointerdown", outside);
    return () => document.removeEventListener("pointerdown", outside);
  }, [expanded]);
  useEffect(() => {
    if (disabled) setExpanded(false);
  }, [disabled]);
  useEffect(() => {
    if (!expanded || active < 0) return;
    document
      .getElementById(`${id}-option-${active}`)
      ?.scrollIntoView({ block: "nearest" });
  }, [active, expanded, id]);
  function choose(option: Option) {
    onChange(option.value);
    setQuery("");
    setExpanded(false);
    setActive(-1);
    input.current?.focus({ preventScroll: true });
  }
  return (
    <div className="search-select" ref={root}>
      <input
        ref={input}
        role="combobox"
        aria-label={label}
        aria-autocomplete="list"
        aria-expanded={expanded}
        aria-controls={`${id}-list`}
        aria-activedescendant={
          expanded && filtered[active] ? `${id}-option-${active}` : undefined
        }
        autoComplete="off"
        disabled={disabled}
        placeholder={placeholder}
        value={
          expanded
            ? query
            : uppercaseText(selected?.label || query || unmatched)
        }
        onFocus={() => {
          if (!disabled) {
            setExpanded(true);
            setQuery("");
            setActive(-1);
          }
        }}
        onClick={() => {
          if (!disabled && !expanded) {
            setExpanded(true);
            setQuery("");
            setActive(-1);
          }
        }}
        onBlur={(event) => {
          if (!root.current?.contains(event.relatedTarget)) setExpanded(false);
        }}
        onChange={(event) => {
          setQuery(event.target.value);
          setExpanded(true);
          setActive(-1);
          if (value) onChange("");
        }}
        onKeyDown={(event) => {
          if (event.key === "ArrowDown" || event.key === "ArrowUp") {
            event.preventDefault();
            if (!expanded) {
              setExpanded(true);
              setQuery("");
            }
            setActive((current) =>
              Math.min(
                filtered.length - 1,
                Math.max(0, current + (event.key === "ArrowDown" ? 1 : -1)),
              ),
            );
          } else if (event.key === "Enter" && expanded) {
            event.preventDefault();
            if (filtered[active]) choose(filtered[active]);
          } else if (event.key === "Escape" && expanded) {
            event.preventDefault();
            event.stopPropagation();
            setExpanded(false);
            setActive(-1);
          } else if (event.key === "Tab") setExpanded(false);
        }}
      />
      <Search size={13} aria-hidden="true" />
      {expanded && (
        <div
          id={`${id}-list`}
          className="search-select-list"
          role="listbox"
          aria-label={`${label} options`}
        >
          {filtered.map((option, index) => (
            <button
              key={option.value}
              id={`${id}-option-${index}`}
              type="button"
              role="option"
              aria-selected={value === option.value}
              tabIndex={-1}
              className={active === index ? "is-active" : ""}
              onPointerDown={(event) => event.preventDefault()}
              onMouseEnter={() => setActive(index)}
              onClick={() => choose(option)}
            >
              {option.label}
            </button>
          ))}
          {!filtered.length && (
            <div className="search-select-empty" role="status">
              No matches
            </div>
          )}
        </div>
      )}
    </div>
  );
}
