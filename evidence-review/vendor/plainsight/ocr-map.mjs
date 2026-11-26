// SPDX-License-Identifier: Apache-2.0
// Source: LevelUpWorldHub/plainsight@0d1349748f7f1f0463f4a1189671d146833ab894 src/lib/phi/ocr-map.ts
// Changes: TypeScript erased and module file extensions updated.
                                       

                          
               
                                                           
 

                          
                
                
              
 

export function joinOcrWords(words           )                                     {
  let text = "";
  const spans            = [];
  for (const word of words) {
    const token = word.text.trim();
    if (!token) continue;
    if (text.length > 0) text += " ";
    const start = text.length;
    text += token;
    spans.push({ word, start, end: text.length });
  }
  return { text, spans };
}

export function wordsOverlappingFindings(
  spans           ,
  findings           ,
)            {
  return spans
    .filter((span) =>
      findings.some(
        (finding) => span.start < finding.end && span.end > finding.start,
      ),
    )
    .map((span) => span.word);
}
