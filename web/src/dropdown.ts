/**
 * A custom listbox, replacing the native `<select>`.
 *
 * The native control renders an operating-system popup that ignores the page's
 * styling entirely, so it is rebuilt here from a button plus a listbox. That
 * means re-implementing what the browser gave us for free — keyboard
 * navigation, focus handling and the ARIA roles a screen reader needs.
 */

export interface DropdownOption {
  value: string;
  label: string;
}

export interface Dropdown {
  readonly value: string;
  setValue(value: string): void;
  onChange(handler: (value: string) => void): void;
}

/** Closing one dropdown when another opens, without a global registry. */
const OPEN_EVENT = "dropdown:open";

export function createDropdown(
  host: HTMLElement,
  options: DropdownOption[],
  initial: string,
  labelledBy?: string,
): Dropdown {
  const trigger = document.createElement("button");
  trigger.type = "button";
  trigger.className = "select-trigger";
  trigger.setAttribute("role", "combobox");
  trigger.setAttribute("aria-haspopup", "listbox");
  trigger.setAttribute("aria-expanded", "false");
  if (labelledBy) trigger.setAttribute("aria-labelledby", labelledBy);

  const valueText = document.createElement("span");
  valueText.className = "select-value";

  const chevron = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  chevron.setAttribute("viewBox", "0 0 24 24");
  chevron.setAttribute("aria-hidden", "true");
  chevron.classList.add("select-chevron");
  const chevronPath = document.createElementNS("http://www.w3.org/2000/svg", "path");
  chevronPath.setAttribute("d", "M7 10l5 5 5-5");
  chevronPath.setAttribute("fill", "none");
  chevronPath.setAttribute("stroke", "currentColor");
  chevronPath.setAttribute("stroke-width", "1.6");
  chevronPath.setAttribute("stroke-linecap", "round");
  chevronPath.setAttribute("stroke-linejoin", "round");
  chevron.append(chevronPath);

  trigger.append(valueText, chevron);

  const menu = document.createElement("ul");
  menu.className = "select-menu";
  menu.setAttribute("role", "listbox");
  menu.hidden = true;

  const items = options.map((option) => {
    const item = document.createElement("li");
    item.className = "select-option";
    item.setAttribute("role", "option");
    item.dataset["value"] = option.value;
    item.textContent = option.label;
    menu.append(item);
    return item;
  });

  host.classList.add("select");
  host.append(trigger, menu);

  let current = initial;
  let activeIndex = Math.max(0, options.findIndex((option) => option.value === initial));
  const handlers: ((value: string) => void)[] = [];

  const paint = () => {
    const selected = options.find((option) => option.value === current);
    valueText.textContent = selected?.label ?? current;
    items.forEach((item, index) => {
      item.setAttribute("aria-selected", String(options[index]!.value === current));
      item.classList.toggle("active", index === activeIndex);
    });
  };

  const isOpen = () => !menu.hidden;

  const close = () => {
    if (!isOpen()) return;
    menu.hidden = true;
    trigger.setAttribute("aria-expanded", "false");
  };

  const open = () => {
    if (isOpen()) return;
    // Tell every other dropdown on the page to close first.
    document.dispatchEvent(new CustomEvent(OPEN_EVENT, { detail: host }));
    menu.hidden = false;
    trigger.setAttribute("aria-expanded", "true");
    activeIndex = Math.max(0, options.findIndex((option) => option.value === current));
    paint();
    items[activeIndex]?.scrollIntoView({ block: "nearest" });
  };

  const select = (index: number) => {
    const option = options[index];
    if (!option) return;
    const changed = option.value !== current;
    current = option.value;
    activeIndex = index;
    paint();
    close();
    trigger.focus();
    if (changed) for (const handler of handlers) handler(current);
  };

  const move = (delta: number) => {
    if (!isOpen()) {
      open();
      return;
    }
    activeIndex = (activeIndex + delta + options.length) % options.length;
    paint();
    items[activeIndex]?.scrollIntoView({ block: "nearest" });
  };

  trigger.addEventListener("click", () => (isOpen() ? close() : open()));

  trigger.addEventListener("keydown", (event) => {
    switch (event.key) {
      case "ArrowDown":
        event.preventDefault();
        move(1);
        break;
      case "ArrowUp":
        event.preventDefault();
        move(-1);
        break;
      case "Home":
        if (isOpen()) {
          event.preventDefault();
          activeIndex = 0;
          paint();
        }
        break;
      case "End":
        if (isOpen()) {
          event.preventDefault();
          activeIndex = options.length - 1;
          paint();
        }
        break;
      case "Enter":
      case " ":
        event.preventDefault();
        if (isOpen()) select(activeIndex);
        else open();
        break;
      case "Escape":
        if (isOpen()) {
          event.preventDefault();
          close();
        }
        break;
      case "Tab":
        close();
        break;
    }
  });

  items.forEach((item, index) => {
    // `mousedown` would blur the trigger before the click lands.
    item.addEventListener("mousedown", (event) => event.preventDefault());
    item.addEventListener("click", () => select(index));
    item.addEventListener("mouseenter", () => {
      activeIndex = index;
      paint();
    });
  });

  document.addEventListener("click", (event) => {
    if (!host.contains(event.target as Node)) close();
  });

  document.addEventListener(OPEN_EVENT, (event) => {
    if ((event as CustomEvent).detail !== host) close();
  });

  paint();

  return {
    get value() {
      return current;
    },
    setValue(value: string) {
      if (!options.some((option) => option.value === value)) return;
      current = value;
      paint();
    },
    onChange(handler: (value: string) => void) {
      handlers.push(handler);
    },
  };
}
