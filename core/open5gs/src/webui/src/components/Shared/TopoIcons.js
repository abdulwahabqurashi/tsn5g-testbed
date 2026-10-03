/* Inline SVG line-icons for topology nodes. Each returns an array of
 * SVG elements drawn in a 24x24 box; caller positions via a <g> transform
 * and scales as needed. Stroke-based, colored by `c`. */

function icon(name, c, key) {
  var p = { fill: 'none', stroke: c, strokeWidth: 1.8,
    strokeLinecap: 'round', strokeLinejoin: 'round' };
  switch (name) {
    case 'core':   /* 5G core: stacked server */
      return (
        <g key={key}>
          <rect x="3" y="4" width="18" height="5" rx="1.5" {...p}/>
          <rect x="3" y="11" width="18" height="5" rx="1.5" {...p}/>
          <rect x="3" y="18" width="18" height="3" rx="1" {...p}/>
          <circle cx="6.5" cy="6.5" r="0.9" fill={c} stroke="none"/>
          <circle cx="6.5" cy="13.5" r="0.9" fill={c} stroke="none"/>
        </g>);
    case 'ran':    /* radio / antenna: broadcast waves */
      return (
        <g key={key}>
          <circle cx="12" cy="9" r="2" {...p}/>
          <path d="M12 11 L12 21" {...p}/>
          <path d="M9.5 20 L14.5 20" {...p}/>
          <path d="M7.8 5.2 A6 6 0 007.8 12.8" {...p}/>
          <path d="M16.2 5.2 A6 6 0 0116.2 12.8" {...p}/>
          <path d="M5.5 3 A9.5 9.5 0 005.5 15" {...p} opacity="0.5"/>
          <path d="M18.5 3 A9.5 9.5 0 0118.5 15" {...p} opacity="0.5"/>
        </g>);
    case 'ue':     /* device / CPE */
      return (
        <g key={key}>
          <rect x="4" y="3" width="16" height="13" rx="2" {...p}/>
          <path d="M9 20 L15 20 M12 16 L12 20" {...p}/>
          <circle cx="7" cy="12.5" r="0.9" fill={c} stroke="none"/>
        </g>);
    case 'device': /* end station / PC */
      return (
        <g key={key}>
          <rect x="3" y="5" width="18" height="11" rx="1.5" {...p}/>
          <path d="M8 20 L16 20 M12 16 L12 20" {...p}/>
        </g>);
    case 'bridge': /* NW-TT / UPF bridge: switch */
      return (
        <g key={key}>
          <rect x="3" y="8" width="18" height="8" rx="1.5" {...p}/>
          <path d="M7 8 L7 5 M17 8 L17 5 M7 16 L7 19 M17 16 L17 19" {...p}/>
          <path d="M6 12 L18 12" {...p} opacity="0.5"/>
        </g>);
    case 'dn':     /* network / globe */
      return (
        <g key={key}>
          <circle cx="12" cy="12" r="9" {...p}/>
          <path d="M3 12 L21 12 M12 3 A13 13 0 010 9 M12 3 A13 13 0 000 9" {...p}/>
          <ellipse cx="12" cy="12" rx="4" ry="9" {...p}/>
        </g>);
    default:
      return <g key={key}/>;
  }
}

/* place an icon at (x,y) scaled to `size` px, tinted `c` */
export function TopoIcon(name, x, y, size, c) {
  var s = size / 24;
  return (
    <g transform={'translate(' + x + ',' + y + ') scale(' + s + ')'}>
      {icon(name, c, name + '-' + x + '-' + y)}
    </g>
  );
}

export default TopoIcon;
