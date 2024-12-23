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

function generateXMLFromPath(filePath) {
  const stats = fs.statSync(filePath);
  
  if (stats.isDirectory()) {
    // If it's a directory, recursively process all files
    const files = fs.readdirSync(filePath);
    let xmlContent = `<directory name="${path.basename(filePath)}" path="${filePath}">\n`;
    
    files.forEach(file => {
      const fullPath = path.join(filePath, file);
      const fileStats = fs.statSync(fullPath);
      
      if (fileStats.isDirectory()) {
        xmlContent += generateXMLFromPath(fullPath);
      } else {
        try {
          const fileContent = fs.readFileSync(fullPath, 'utf-8');
          xmlContent += `  <file name="${file}" path="${fullPath}">\n`;
          xmlContent += `    <content><![CDATA[${fileContent}]]></content>\n`;
          xmlContent += `  </file>\n`;
        } catch (error) {
          console.error(`Could not read file ${file}: ${error}`);
        }
      }
    });
    
    xmlContent += `</directory>\n`;
    return xmlContent;
  } else {
    // If it's a single file
    try {
      const fileContent = fs.readFileSync(filePath, 'utf-8');
      let xmlContent = `<file name="${path.basename(filePath)}" path="${filePath}">\n`;
      xmlContent += `  <content><![CDATA[${fileContent}]]></content>\n`;
      xmlContent += `</file>`;
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
  const filePaths = Array.isArray(payload) ? payload : 
                    (payload.filePaths || []);
  const request = typeof payload === 'object' ? (payload.request || '') : '';

  let finalXML = '<?xml version="1.0" encoding="UTF-8"?>\n<files>\n';
  
  // Add the Prompt section at the beginning
  finalXML += `  <Prompt>
    <Instructions>
      <Statement>
        **READ AND FOLLOW CAREFULLY:** You are an expert software engineer and must adhere to all instructions in this prompt EXACTLY. You must produce the highest-quality, fully integrated, error-free, and complete solution. Dedicate as much computation and reasoning time as needed. Do NOT take shortcuts, do NOT skip steps. Carefully reason through every requirement and ensure absolute consistency and correctness. Your final output must be polished, robust, and follow all given conventions and instructions meticulously.
      </Statement>
      <Statement>
        Use the MOST compute and take as long as needed to ensure the solution is thorough, correct, and integrates every feature fully. Implement all features robustly, including error handling, logs, and consistent CRUD functionality in both the backend and the frontend. Ensure that all logic for adjustments is perfectly integrated and functional. Confirm that the frontend CRUD pages, map overlays, and metric adjustments are fully implemented. Include all fields, timestamps, logs, and reasons as described.
      </Statement>
      <Statement>
        Make sure to include inline code comments wherever needed to clarify non-obvious implementations. The code must be clean, readable, and maintainable. The final integrated solution must be deployment-ready and adhere to best practices.
      </Statement>
      <ResponseInstructions>
        <SummarySectionNotes>
            Here are some notes on how you should respond in the summary section:
            - Provide a brief overall summary
            - Provide a 1-sentence summary for each file changed and why.
            - Provide a 1-sentence summary for each file deleted and why.
            - Format this section as markdown.
        </SummarySectionNotes>
        <XMLSectionNotes>
            Here are some notes on how you should respond in the XML section:
            - Respond with the XML and nothing else
            - Include all of the changed files
            - Specify each file operation with CREATE, UPDATE, or DELETE
            - If it is a CREATE or UPDATE include the full file code. Do not get lazy.
            - Each file should include a brief change summary.
            - Include the full file path
            - I am going to copy/paste that entire XML section into a parser to automatically apply the changes you made, so put the XML block inside a markdown codeblock.
            - Make sure to enclose the code with <![CDATA[__CODE HERE__]] in the file_code section.
        </XMLSectionNotes>
        <FinalXMLStructure>
            The XML section will be:
            
xml
            <code_changes>
                <changed_files>
                    <file>
                        <file_summary>**BRIEF CHANGE SUMMARY HERE**</file_summary>
                        <file_operation>**FILE OPERATION HERE**</file_operation>
                        <file_path>**FILE PATH HERE**</file_path>
                        <file_code><![CDATA[
__FULL FILE CODE HERE__
]]></file_code>
                    </file>
                    <!-- REMAINING FILES HERE -->
                </changed_files>
            </code_changes>

        </FinalXMLStructure>
      </ResponseInstructions>
    </Instructions>
  </Prompt>
  <Request>${xmlEscape(request)}</Request>\n`;
  
  // Ensure filePaths is an array before using forEach
  if (Array.isArray(filePaths)) {
    filePaths.forEach(filePath => {
      finalXML += generateXMLFromPath(filePath);
    });
  }
  
  finalXML += '</files>';
  
  // Copy to clipboard
  clipboard.writeText(finalXML);
  
  return finalXML;
});

ipcMain.handle('apply-xml', async (event, xmlContent) => {
  try {
    // Parse XML content
    const parser = new xml2js.Parser();
    const result = await parser.parseStringPromise(xmlContent);
    
    if (!result.code_changes?.changed_files?.[0]?.file) {
      throw new Error('Invalid XML structure: Missing code_changes/changed_files/file elements');
    }

    const fileElements = result.code_changes.changed_files[0].file;
    const results = [];
    
    // First pass: Store original contents of files that will be modified
    for (const fileElement of fileElements) {
      const operation = fileElement.file_operation?.[0];
      const filePath = fileElement.file_path?.[0];
      
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
      const summary = fileElement.file_summary?.[0];
      const operation = fileElement.file_operation?.[0];
      const filePath = fileElement.file_path?.[0];
      const codeContent = fileElement.file_code?.[0];
      
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
