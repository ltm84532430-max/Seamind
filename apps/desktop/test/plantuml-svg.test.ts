import { describe, expect, it } from 'vitest';
import { plantUmlDiagramNames, splitSvgDocuments } from '../src/plantuml-svg';

const svg = (label: string) =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><text>${label}</text></svg>`;

describe('splitSvgDocuments', () => {
  it('returns a single document as it is', () => {
    expect(splitSvgDocuments(svg('a'))).toEqual([svg('a')]);
  });

  it('splits the documents PlantUML writes back to back for several diagrams', () => {
    expect(splitSvgDocuments(svg('a') + svg('b') + '\n' + svg('c'))).toEqual([
      svg('a'),
      svg('b'),
      svg('c'),
    ]);
  });

  it('keeps a nested svg inside its parent document', () => {
    const outer = `<svg xmlns="http://www.w3.org/2000/svg"><svg x="1"><rect/></svg><text>t</text></svg>`;
    expect(splitSvgDocuments(outer + svg('next'))).toEqual([
      outer,
      svg('next'),
    ]);
  });

  it('drops an XML declaration and the whitespace around documents', () => {
    expect(
      splitSvgDocuments(
        `<?xml version="1.0"?>\n${svg('a')}\n\n  ${svg('b')}\n`,
      ),
    ).toEqual([svg('a'), svg('b')]);
  });

  it('keeps the text of the first document when a later one is cut off', () => {
    expect(
      splitSvgDocuments(
        svg('a') + '<svg xmlns="http://www.w3.org/2000/svg"><g>',
      ),
    ).toEqual([svg('a')]);
  });

  it('returns incomplete output as it is so the caller can report it', () => {
    const cut = '<svg xmlns="http://www.w3.org/2000/svg"><g>';
    expect(splitSvgDocuments(cut)).toEqual([cut]);
  });

  it('returns nothing for blank output', () => {
    expect(splitSvgDocuments('  \n')).toEqual([]);
  });
});

describe('plantUmlDiagramNames', () => {
  it('lists the name after each @start line', () => {
    const source = [
      '@startuml orderflow_architecture',
      'a -> b',
      '@enduml',
      '',
      '@startuml orderflow_startup_and_recovery',
      '@enduml',
    ].join('\n');
    expect(plantUmlDiagramNames(source)).toEqual([
      'orderflow_architecture',
      'orderflow_startup_and_recovery',
    ]);
  });

  it('uses an empty name for an unnamed block and understands other @start kinds', () => {
    expect(
      plantUmlDiagramNames(
        '@startuml\r\n@enduml\r\n@startmindmap tree\r\n@endmindmap',
      ),
    ).toEqual(['', 'tree']);
  });
});
