/*****************************************************************************************
 * main.js
 *****************************************************************************************/
const { app, BrowserWindow, ipcMain, dialog, clipboard } = require('electron');
const path = require('path');
const fs = require('fs-extra');
const xmlEscape = require('xml-escape');
const xml2js = require('xml2js');

// Path for storing change history
const historyPath = path.join(app.getPath('userData'), 'change-history.json');

// Initialize or load change history
let changeHistory = [];
try {
  if (fs.existsSync(historyPath)) {
    changeHistory = JSON.parse(fs.readFileSync(historyPath, 'utf-8'));
  }
} catch (error) {
  console.error('Error loading change history:', error);
}

// Save change history
function saveHistory() {
  try {
    fs.writeFileSync(historyPath, JSON.stringify(changeHistory, null, 2));
  } catch (error) {
    console.error('Error saving change history:', error);
  }
}

// Add entry to history
function addHistoryEntry(changes) {
  const entry = {
    timestamp: new Date().toISOString(),
    changes: changes.map(change => ({
      operation: change.operation,
      path: change.path,
      summary: change.summary || '',
      success: change.success,
      error: change.error || null
    }))
  };

  changeHistory.unshift(entry); // Add to beginning of array
  if (changeHistory.length > 100) { // Keep only last 100 entries
    changeHistory.pop();
  }

  saveHistory();
  return entry;
}

function createWindow() {
  const packageInfo = require('./package.json');
  const iconPath = path.join(__dirname, 'resources', 'logo.png');
  const win = new BrowserWindow({
    width: 1200,
    height: 900,
    minWidth: 1000,
    minHeight: 700,
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false
    },
    backgroundColor: '#ffffff',
    titleBarStyle: 'default',
    title: `File to XML Paster v${packageInfo.version}`,
    icon: iconPath,
    show: false // Don't show until ready
  });

  // Set about panel info for macOS
  if (process.platform === 'darwin') {
    app.setAboutPanelOptions({
      applicationName: 'File to XML Paster',
      applicationVersion: packageInfo.version,
      version: packageInfo.version,
      copyright: packageInfo.copyright,
      authors: [packageInfo.author]
    });
  }

  win.loadFile('index.html');

  // Show window when ready to prevent flashing
  win.once('ready-to-show', () => {
    win.show();
  });

  // Open devtools in development
  if (process.env.NODE_ENV === 'development') {
    win.webContents.openDevTools();
  }
}

/**
 * Generate safe CDATA content by replacing "]]>" inside file content so we don't end up 
 * accidentally closing the CDATA block. We convert "]]>" -> "]]]]><![CDATA[>" for safety.
 */
function makeSafeCDATA(fileContent) {
  return fileContent.replace(/\]\]>/g, ']]]]><![CDATA[>');
}

/**
 * Recursively build an XML representation of a file or directory.
 * Ensures that embedded "]]>" sequences are made safe in CDATA.
 */
function generateXMLFromPath(filePath) {
  const stats = fs.statSync(filePath);

  if (stats.isDirectory()) {
    // If it's a directory, recursively process all files
    const files = fs.readdirSync(filePath);
    let xmlContent = `<DIRECTORY name="${path.basename(filePath)}" path="${filePath}">\n`;

    files.forEach(file => {
      const fullPath = path.join(filePath, file);
      const fileStats = fs.statSync(fullPath);

      if (fileStats.isDirectory()) {
        xmlContent += generateXMLFromPath(fullPath);
      } else {
        try {
          const fileContent = fs.readFileSync(fullPath, 'utf-8');
          const safeContent = makeSafeCDATA(fileContent);
          xmlContent += `  <FILE name="${file}" path="${fullPath}">
    <CONTENT><![CDATA[${safeContent}]]]]><![CDATA[></CONTENT>
  </FILE>
`;
        } catch (error) {
          console.error(`Could not read file ${file}: ${error}`);
        }
      }
    });

    xmlContent += `</DIRECTORY>\n`;
    return xmlContent;
  } else {
    // If it's a single file
    try {
      const fileContent = fs.readFileSync(filePath, 'utf-8');
      const safeContent = makeSafeCDATA(fileContent);
      let xmlContent = `<FILE name="${path.basename(filePath)}" path="${filePath}">
  <CONTENT><![CDATA[${safeContent}]]]]><![CDATA[></CONTENT>
</FILE>`;
      return xmlContent;
    } catch (error) {
      console.error(`Could not read file ${filePath}: ${error}`);
      return '';
    }
  }
}

// Store original file contents before changes
let originalFileContents = new Map();

// Register all IPC handlers immediately
ipcMain.handle('get-history', async () => {
  try {
    // Ensure history is loaded
    if (fs.existsSync(historyPath)) {
      changeHistory = JSON.parse(await fs.promises.readFile(historyPath, 'utf-8'));
    }
    return changeHistory;
  } catch (error) {
    console.error('Error loading history:', error);
    return [];
  }
});

ipcMain.handle('select-files', async (event) => {
  const result = await dialog.showOpenDialog({
    properties: ['openFile', 'multiSelections', 'openDirectory'],
    filters: [
      { name: 'All Files', extensions: ['*'] },
      { name: 'Code Files', extensions: ['py', 'js', 'ts', 'tsx', 'jsx', 'html', 'css', 'xml', 'txt', 'json', 'md'] },
      { name: 'Python', extensions: ['py'] },
      { name: 'JavaScript', extensions: ['js', 'jsx'] },
      { name: 'TypeScript', extensions: ['ts', 'tsx'] },
      { name: 'Web Files', extensions: ['html', 'css'] },
      { name: 'Text Files', extensions: ['txt', 'md'] },
      { name: 'XML', extensions: ['xml'] }
    ]
  });
  return result.filePaths;
});

ipcMain.handle('generate-xml', (event, payload) => {
  // Ensure payload is an object and has filePaths
  const filePaths = Array.isArray(payload) ? payload : (payload.filePaths || []);
  const request = typeof payload === 'object' ? (payload.request || '') : '';

  let finalXML = '<?xml version="1.0" encoding="UTF-8"?>\n<FILES>\n';

  // Add the Prompt section at the beginning
  finalXML += `  <PROMPT>
    <INSTRUCTIONS>
      <STATEMENT>
        **READ AND FOLLOW CAREFULLY:** You are an expert software engineer and must adhere to all instructions in this prompt EXACTLY. You must produce the highest-quality, fully integrated, error-free, and complete solution. Dedicate as much computation and reasoning time as needed. Do NOT take shortcuts, do NOT skip steps. Carefully reason through every requirement and ensure absolute consistency and correctness. Your final output must be polished, robust, and follow all given conventions and instructions meticulously.
      </STATEMENT>
      <STATEMENT>
        Use the MOST compute and take as long as needed to ensure the solution is thorough, correct, and integrates every feature fully. Implement all features robustly, including error handling, logs, and consistent CRUD functionality in both the backend and the frontend. Ensure that all logic for adjustments is perfectly integrated and functional. Confirm that the frontend CRUD pages, map overlays, and metric adjustments are fully implemented. Include all fields, timestamps, logs, and reasons as described.
      </STATEMENT>
      <STATEMENT>
        Make sure to include inline code comments wherever needed to clarify non-obvious implementations. The code must be clean, readable, and maintainable. The final integrated solution must be deployment-ready and adhere to best practices.
      </STATEMENT>
      <STATEMENT>
        IMPORTANT XML CONVENTION: When providing code that contains XML (like HTML, JSX, XML configurations, etc.), use lowercase tags within that code. Only the structural XML tags used for organizing file changes (CODE_CHANGES, FILE, etc.) should be uppercase. This helps distinguish between XML used for structure vs XML within actual code content.
      </STATEMENT>
      <RESPONSE_INSTRUCTIONS>
        <SUMMARY_SECTION_NOTES>
            Here are some notes on how you should respond in the summary section:
            - Provide a brief overall summary
            - Provide a 1-sentence summary for each file changed and why.
            - Provide a 1-sentence summary for each file deleted and why.
            - Format this section as markdown.
        </SUMMARY_SECTION_NOTES>
        <XML_SECTION_NOTES>
            Here are some notes on how you should respond in the XML section:
            - Respond with the XML and nothing else
            - Include all of the changed files
            - Specify each file operation with CREATE, UPDATE, or DELETE
            - If it is a CREATE or UPDATE include the full file code. Do not get lazy.
            - Each file should include a brief change summary.
            - Include the full file path
            - I am going to copy/paste that entire XML section into a parser to automatically apply the changes you made, so put the XML block inside a markdown codeblock.
            - Make sure to enclose the code with <![CDATA[__CODE HERE__]] in the file_code section.
        </XML_SECTION_NOTES>
        <FINAL_XML_STRUCTURE>
            The XML section will be:
            
xml
            <CODE_CHANGES>
                <CHANGED_FILES>
                    <FILE>
                        <FILE_SUMMARY>**BRIEF CHANGE SUMMARY HERE**</FILE_SUMMARY>
                        <FILE_OPERATION>**FILE OPERATION HERE**</FILE_OPERATION>
                        <FILE_PATH>**FILE PATH HERE**</FILE_PATH>
                        <FILE_CODE><![CDATA[
__FULL FILE CODE HERE__
]]]]><![CDATA[></FILE_CODE>
                    </FILE>
                    <!-- REMAINING FILES HERE -->
                </CHANGED_FILES>
            </CODE_CHANGES>

        </FINAL_XML_STRUCTURE>
      </RESPONSE_INSTRUCTIONS>
    </INSTRUCTIONS>
  </PROMPT>
  <REQUEST>${xmlEscape(request)}</REQUEST>\n`;

  // Ensure filePaths is an array before using forEach
  if (Array.isArray(filePaths)) {
    filePaths.forEach(filePath => {
      finalXML += generateXMLFromPath(filePath);
    });
  }

  finalXML += '</FILES>';

  // Copy to clipboard
  clipboard.writeText(finalXML);

  return finalXML;
});

// NEW IPC HANDLER FOR GENERATING LINE-ANCHORED PROMPT
ipcMain.handle('generate-line-anchored-prompt', (event, payload) => {
  /*
    This function returns an advanced prompt that instructs the LLM on how to apply
    line-anchored code changes using line numbers and anchor patterns for context matching.
    We incorporate the user request into the prompt as well.
  */
  const filePaths = Array.isArray(payload) ? payload : (payload.filePaths || []);
  const request = typeof payload === 'object' ? (payload.request || '') : '';

  // Example advanced prompt content:
  const promptContent = `
**LINE-ANCHORED MODE INSTRUCTIONS:**
Use the following format to specify code changes by line number and anchor patterns. 
Include 2-3 lines above and below each target line as anchors to ensure context matching. 
Validate changes with a confidence score, ensuring the target line hasn't drifted from the intended location. 
If anchors mismatch, prompt the user for manual verification.

**CORE REQUIREMENTS:**
- Maintain precise code edits by referencing line numbers and anchors
- Implement safety checks and confidence scoring
- Avoid partial or ambiguous matches
- Combine line-based specificity with anchor-based context to handle line drift
- For each file, detail the lines to be changed, the anchor lines, and the new code or deletion

**IMPLEMENTATION OUTLINE:**
1. Parse line numbers + anchor lines from the user or from an automated system
2. Verify code context around those lines
3. Calculate confidence in anchor matching
4. If below threshold, request user confirmation
5. Apply changes only if safe
6. Insert logs referencing line changes, anchor patterns, and any adjustments

**USER REQUEST:** 
${request}

**FORMAT EXAMPLE:**
<CODE_CHANGES>
  <CHANGED_FILES>
    <FILE>
      <FILE_SUMMARY>Example anchored update</FILE_SUMMARY>
      <FILE_OPERATION>UPDATE</FILE_OPERATION>
      <FILE_PATH>/path/to/file.js</FILE_PATH>
      <LINE_ANCHORED_CODE>
        <![CDATA[
          {
            "changes": [
              {
                "lineNumber": 50,
                "anchors": {
                  "above": [
                    "// This is a function that returns X",
                    "function getX() {"
                  ],
                  "below": [
                    "}",
                    "// End of function"
                  ]
                },
                "newCode": "  return updatedValue;"
              }
            ],
            "safetyCheck": "high"
          }
        ]]>
      </LINE_ANCHORED_CODE>
    </FILE>
  </CHANGED_FILES>
</CODE_CHANGES>

Remember to keep structural tags uppercase and code contents in lowercase tags where possible.
`;

  return promptContent.trim();
});

// XML validation helper functions
function validateXMLContent(xmlContent) {
  const issues = [];

  // Helper to check if a line is within a template literal
  function isInTemplateLiteral(lines, currentIndex) {
    let backtickCount = 0;
    for (let i = 0; i <= currentIndex; i++) {
      const matches = lines[i].match(/`/g);
      if (matches) {
        backtickCount += matches.length;
      }
    }
    return backtickCount % 2 === 1; // Odd count means we're inside backticks
  }

  // Helper to check if a line is within a CDATA section
  function isInCDATA(lines, currentIndex) {
    let cdataStart = false;
    for (let i = 0; i <= currentIndex; i++) {
      if (lines[i].includes('<![CDATA[')) {
        cdataStart = true;
      }
      if (lines[i].includes(']]]]><![CDATA[>')) {
        cdataStart = false;
      }
    }
    return cdataStart;
  }

  const lines = xmlContent.split('\n');

  // Track CDATA and template literal state
  let inTemplateLiteral = false;
  let inCDATA = false;
  let cdataCount = 0;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // Update template literal state
    const backticks = line.match(/`/g);
    if (backticks) {
      for (let j = 0; j < backticks.length; j++) {
        inTemplateLiteral = !inTemplateLiteral;
      }
    }

    // Update CDATA state
    if (line.includes('<![CDATA[')) {
      if (inCDATA) {
        issues.push(`Line ${i + 1}: Nested CDATA section detected. CDATA sections cannot be nested.`);
      }
      inCDATA = true;
      cdataCount++;
    }
    if (line.includes(']]]]><![CDATA[>')) {
      inCDATA = false;
      cdataCount--;
    }

    // Check for unescaped CDATA end sequence
    if (line.includes(']]]]><![CDATA[>')) {
      // Only flag if not in a template literal and not a proper CDATA closing
      const cdataCloseIndex = line.indexOf(']]]]><![CDATA[>');
      const lineUpToCdata = line.substring(0, cdataCloseIndex);
      if (
        !isInTemplateLiteral(lines, i) &&
        !lineUpToCdata.includes('<![CDATA[') &&
        !line.trim().startsWith('xmlContent += `')
      ) {
        issues.push(`Line ${i + 1}: Contains unescaped CDATA end sequence ']]]]><![CDATA[>'. If this is within code, consider using string concatenation or escaping.`);
      }
    }
  }

  // Check for unclosed CDATA sections
  if (cdataCount !== 0) {
    issues.push('Unclosed CDATA section detected. Each <![CDATA[ must have a matching ]]]]><![CDATA[>');
  }

  // Check for basic XML structure only in the actual XML (not in template literals)
  const nonTemplateContent = xmlContent.split('`').filter((_, i) => i % 2 === 0).join('');
  if (!nonTemplateContent.includes('<CODE_CHANGES>')) {
    issues.push('Missing root <CODE_CHANGES> element');
  }
  if (!nonTemplateContent.includes('<CHANGED_FILES>')) {
    issues.push('Missing <CHANGED_FILES> element');
  }
  if (!nonTemplateContent.includes('<FILE>')) {
    issues.push('Missing <FILE> element(s)');
  }
  // If the user doesn't have <DIRECTORY> in their changes, we don't want to force an error.
  // But if they do and it's lowercase, warn them. We'll leave this check:
  if (nonTemplateContent.includes('<directory>') || nonTemplateContent.includes('<file>') || nonTemplateContent.includes('<content>')) {
    issues.push('Found lowercase XML tags for structure. All structural tags must be uppercase.');
  }

  return issues;
}

function getXMLLineNumber(xmlContent, searchString) {
  const lines = xmlContent.split('\n');
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].includes(searchString)) {
      return i + 1;
    }
  }
  return -1;
}

function validateFileElement(fileElement) {
  const issues = [];

  // Check required elements
  if (!fileElement.FILE_SUMMARY?.[0]) {
    issues.push('Missing FILE_SUMMARY element');
  }
  if (!fileElement.FILE_OPERATION?.[0]) {
    issues.push('Missing FILE_OPERATION element');
  } else {
    const operation = fileElement.FILE_OPERATION[0].toUpperCase();
    if (!['CREATE', 'UPDATE', 'DELETE'].includes(operation)) {
      issues.push(`Invalid FILE_OPERATION: ${operation}. Must be CREATE, UPDATE, or DELETE`);
    }
  }
  if (!fileElement.FILE_PATH?.[0]) {
    issues.push('Missing FILE_PATH element');
  }
  if (!fileElement.FILE_CODE && ['CREATE', 'UPDATE'].includes(fileElement.FILE_OPERATION?.[0].toUpperCase())) {
    issues.push('Missing FILE_CODE element for CREATE/UPDATE operation');
  }

  return issues;
}

ipcMain.handle('apply-xml', async (event, xmlContent) => {
  try {
    // First validate XML content for common issues
    const validationIssues = validateXMLContent(xmlContent);
    if (validationIssues.length > 0) {
      return {
        success: false,
        error: 'XML Validation Errors:\n' + validationIssues.join('\n')
      };
    }

    // Parse XML content
    const parser = new xml2js.Parser({
      explicitArray: true,
      valueProcessors: [
        function (value) {
          // Additional processing/validation could be added here
          return value;
        }
      ]
    });

    let result;
    try {
      result = await parser.parseStringPromise(xmlContent);
    } catch (parseError) {
      // Get line number from error message if available
      const lineMatch = parseError.message.match(/Line: (\d+)/);
      const columnMatch = parseError.message.match(/Column: (\d+)/);
      const line = lineMatch ? lineMatch[1] : getXMLLineNumber(xmlContent, parseError.message);
      const column = columnMatch ? columnMatch[1] : '?';

      let errorMsg = `XML Parse Error at line ${line}, column ${column}:\n${parseError.message}\n`;

      // Add context if we have the line number
      if (line > 0) {
        const lines = xmlContent.split('\n');
        const contextStart = Math.max(0, line - 3);
        const contextEnd = Math.min(lines.length, parseInt(line) + 2);

        errorMsg += '\nContext:\n';
        for (let i = contextStart; i < contextEnd; i++) {
          errorMsg += `${i + 1}: ${lines[i]}\n`;
          if (i + 1 === parseInt(line)) {
            errorMsg += `${' '.repeat(column)}^ Error occurs here\n`;
          }
        }
      }

      return {
        success: false,
        error: errorMsg
      };
    }

    if (!result.CODE_CHANGES?.CHANGED_FILES?.[0]?.FILE) {
      throw new Error('Invalid XML structure: Missing CODE_CHANGES/CHANGED_FILES/FILE elements');
    }

    const fileElements = result.CODE_CHANGES.CHANGED_FILES[0].FILE;
    const results = [];

    // First pass: Store original contents of files that will be modified
    for (const fileElement of fileElements) {
      const operation = fileElement.FILE_OPERATION?.[0];
      const filePath = fileElement.FILE_PATH?.[0];

      if (operation && filePath && (operation.toUpperCase() === 'UPDATE' || operation.toUpperCase() === 'DELETE')) {
        try {
          if (fs.existsSync(filePath)) {
            originalFileContents.set(filePath, fs.readFileSync(filePath, 'utf-8'));
          }
        } catch (error) {
          console.error(`Error reading original file ${filePath}:`, error);
        }
      }
    }

    for (const fileElement of fileElements) {
      const summary = fileElement.FILE_SUMMARY?.[0];
      const operation = fileElement.FILE_OPERATION?.[0];
      const filePath = fileElement.FILE_PATH?.[0];
      const codeContent = fileElement.FILE_CODE?.[0];

      if (!operation || !filePath) {
        throw new Error('Missing required file operation or path');
      }

      // The XML parser automatically handles CDATA sections
      const code = codeContent || '';

      try {
        switch (operation.toUpperCase()) {
          case 'CREATE':
          case 'UPDATE':
            // Ensure the directory exists
            const dir = path.dirname(filePath);
            await fs.promises.mkdir(dir, { recursive: true });

            // Write/update the file
            await fs.promises.writeFile(filePath, code, 'utf-8');
            results.push({ path: filePath, operation, success: true });
            break;

          case 'DELETE':
            // Check if file exists before attempting deletion
            if (await fs.promises.access(filePath).then(() => true).catch(() => false)) {
              await fs.promises.unlink(filePath);
              results.push({ path: filePath, operation, success: true });
            } else {
              results.push({
                path: filePath,
                operation,
                success: false,
                error: 'File does not exist'
              });
            }
            break;

          default:
            throw new Error(`Unknown operation: ${operation}`);
        }
      } catch (error) {
        results.push({
          path: filePath,
          operation,
          success: false,
          error: error.message
        });
      }
    }

    // Check if any operations failed
    const failures = results.filter(r => !r.success);
    if (failures.length > 0) {
      return {
        success: false,
        error: `Failed operations:\n${failures.map(f =>
          `${f.operation} ${f.path}: ${f.error}`
        ).join('\n')}`
      };
    }

    // Create history entry for successful changes
    const historyEntry = addHistoryEntry(results);

    // Add original and new content to the history entry
    historyEntry.changes = historyEntry.changes.map(change => {
      const originalContent = originalFileContents.get(change.path);
      let newContent = null;

      if (change.operation.toUpperCase() === 'UPDATE') {
        try {
          newContent = fs.readFileSync(change.path, 'utf-8');
        } catch (error) {
          console.error(`Error reading updated file ${change.path}:`, error);
        }
      }

      return {
        ...change,
        originalContent: originalContent || null,
        newContent: newContent
      };
    });

    // Clear the original contents map
    originalFileContents.clear();

    return {
      success: true,
      message: `Successfully applied changes to ${results.length} files`,
      historyEntry
    };
  } catch (error) {
    return {
      success: false,
      error: `Error parsing or applying XML: ${error.message}`
    };
  }
});

app.whenReady().then(() => {
  createWindow();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

// Save history before quitting
app.on('before-quit', () => {
  saveHistory();
});
