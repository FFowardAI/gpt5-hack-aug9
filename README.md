# GPT-5 x Maestro: Visual QA Engineer-in-the-Loop

> **Autopilot for UI Development** - An AI-powered system that automatically generates, runs, and validates UI tests using GPT-5, Maestro, and MCP integration.

## 🎯 Overview

BotaFlow is a cutting-edge system that enables non-coders to iterate on frontend development with AI-powered visual validation. Users can request UI changes in natural language, and the system automatically:

1. **Generates UI tests** using GPT-5 and context-free grammar
2. **Runs tests headlessly** with the Maestro testing framework
3. **Analyzes results visually** and provides feedback to Cursor
4. **Creates visual diffs** and submits PRs with before/after comparisons
5. **Enables element inspection** through a user-friendly UI tool

## 🏗️ Architecture

![](assets/system.png)

## 🚀 Components

### 1. **MCP Server** (`mcp/`)
- **Purpose**: Model Context Protocol server for Cursor integration
- **Features**: Handles test generation requests, manages job status, integrates with Copper
- **Tech Stack**: Python, FastAPI

### 2. **Test Generation Server** (`server/`)
- **Purpose**: Core AI test generation and execution engine
- **Features**: 
  - GPT-5 powered Maestro YAML generation
  - Real-time test execution with retry logic
  - Failure analysis and test regeneration
  - Visual diff reporting
- **Tech Stack**: Node.js, TypeScript, OpenAI API

### 3. **Web Demo App** (`web/`)
- **Purpose**: Sample Next.js application for testing
- **Features**: Landing page with sign-up flow, activity tracking UI
- **Tech Stack**: Next.js, React, Tailwind CSS

### 4. **UI Inspector Tool** (`our-tool/`)
- **Purpose**: Browser-based element inspection and analysis
- **Features**:
  - Click-to-select UI elements
  - GPT-powered element analysis
  - Cursor integration via MCP logging
  - Codebase path resolution
- **Tech Stack**: React, Vite, OpenAI API

### 5. **Visual QA System** (`qa/`)
- **Purpose**: Visual regression testing infrastructure
- **Features**:
  - Baseline image management
  - Automated visual diff generation
  - PR integration with before/after comparisons

## 🛠️ Setup & Installation

### Prerequisites

- **Node.js** 18+ and npm
- **Python** 3.8+ and pip
- **Maestro CLI** - [Installation Guide](https://maestro.mobile.dev/getting-started/installing-maestro)
- **OpenAI API Key** - Required for GPT-5 integration

### Quick Start

1. **Clone the repository**
   ```bash
   git clone <repository-url>
   cd gpt5-hack-aug9
   ```

2. **Setup MCP Server**
   ```bash
   cd mcp
   python -m venv venv
   source venv/bin/activate  # or `venv\Scripts\activate` on Windows
   pip install -r requirements.txt
   
   # Configure settings
   cp config.json.example config.json
   # Edit config.json with your settings
   ```

3. **Setup Test Generation Server**
   ```bash
   cd server
   npm install
   
   # Create environment file
   echo "OPENAI_API_KEY=your_openai_api_key_here" > .env
   echo "PORT=5055" >> .env
   ```

4. **Setup Web Demo**
   ```bash
   cd web
   npm install
   ```

5. **Setup UI Inspector Tool**
   ```bash
   cd our-tool
   npm install
   ```

### Running the System

1. **Start the Test Generation Server**
   ```bash
   cd server
   npm start
   # Server runs on http://localhost:5055
   ```

2. **Start the MCP Server**
   ```bash
   cd mcp
   python server.py
   # MCP server ready for Cursor integration
   ```

3. **Start the Web Demo** (for testing)
   ```bash
   cd web
   npm run dev
   # Demo app runs on http://localhost:3000
   ```

4. **Start the UI Inspector Tool**
   ```bash
   cd our-tool
   npm run dev -- --folder-path=/path/to/your/project --app-url=http://localhost:3000
   # Inspector runs on http://localhost:5174
   ```

## 📋 Usage

### Basic Workflow

1. **Make UI changes** in your codebase using Cursor
2. **Request test generation** through MCP integration:
   - Cursor calls MCP server with modification context
   - GPT-5 analyzes changes and generates Maestro tests
   - Tests run automatically in headless browser
3. **Review results**:
   - Visual diffs appear in PR comments
   - GPT-5 provides analysis and recommendations
   - Iterate based on feedback

### UI Inspector Tool

1. **Open the inspector** at http://localhost:5174
2. **Navigate to your app** using the embedded browser
3. **Click elements** to select and analyze them
4. **Copy analysis** to Cursor for integration
5. **Use MCP logging** for structured element data

### Manual Test Execution

You can also run tests manually using the Maestro CLI:

```bash
# Run a single test
maestro test samples/android-flow.yaml

# Run in headless mode
maestro test --headless samples/android-flow.yaml

# Generate test via API
curl -X POST http://localhost:5055/api/generate-tests \
  -H "Content-Type: application/json" \
  -d '{
    "userMessage": "Test the sign-up flow",
    "modifiedFiles": [{"path": "web/src/app/page.tsx", "diff": "..."}],
    "relatedFiles": ["web/package.json"]
  }'
```

## 🎨 Visual QA Features

### Automated Visual Testing
- **Baseline Management**: Golden reference images stored in `qa/baselines/`
- **Screenshot Capture**: Automatic screenshot generation during test runs
- **Visual Diff Analysis**: GPT-5 powered comparison and analysis
- **PR Integration**: Automated before/after comparisons in pull requests

### CI/CD Integration

The system includes GitHub Actions workflows for:
- **Visual PR Comments**: Automatic visual diff reporting
- **Baseline Updates**: Streamlined approval process for visual changes
- **Test Execution**: Automated testing on code changes

## 🔧 Configuration

### Environment Variables

**Server** (`.env`):
```env
OPENAI_API_KEY=your_openai_api_key_here
PORT=5055
MAESTRO_BIN=maestro
MAESTRO_WORKSPACE=/path/to/workspace
MAESTRO_FLOW_DIR=/path/to/flows
MCP_WEBHOOK_URL=http://localhost:3001/webhook
```

**MCP Server** (`config.json`):
```json
{
  "copperEnabled": false,
  "apiBaseUrl": "http://localhost:5055"
}
```

### Maestro Configuration

The system uses a custom Maestro grammar defined in `TestGen/maestro_grammar.lark` for generating valid YAML tests. Command documentation is provided in `TestGen/COMMANDS.prompt`.

## 🎯 Key Features

### 🤖 AI-Powered Test Generation
- **Natural Language Processing**: Converts user requests to executable tests
- **Context-Aware**: Analyzes code changes and generates relevant tests
- **Retry Logic**: Automatically regenerates tests based on failure feedback
- **Grammar Validation**: Uses Lark parser for syntactically correct Maestro YAML

### 🎨 Visual Validation
- **Screenshot Comparison**: Automated before/after visual diffs
- **GPT-5 Analysis**: Intelligent interpretation of visual changes
- **PR Integration**: Embedded visual reports in pull requests
- **Baseline Management**: Version-controlled reference images

### 🔍 Element Inspection
- **Interactive Selection**: Click-to-select UI elements
- **GPT Analysis**: AI-powered element understanding
- **Codebase Integration**: Automatic source code path resolution
- **MCP Logging**: Structured data for Cursor integration

### 🔄 Continuous Integration
- **Automated Testing**: Tests run on every code change
- **Visual Reporting**: Automatic PR comments with test results
- **Failure Analysis**: AI-powered debugging and suggestions
- **Iterative Improvement**: Closed-loop feedback system

## 📊 System Requirements

### Performance Specifications
- **Concurrent Analysis**: 3 parallel GPT requests maximum
- **File Size Limits**: Large files truncated for analysis
- **Cache Management**: 24-hour cache expiry with OPFS storage
- **Rate Limiting**: Built-in OpenAI API rate limit handling

### Browser Support
- **Chrome/Chromium**: Primary support for headless testing
- **WebDriver**: Selenium-based automation
- **Cross-platform**: Works on macOS, Linux, and Windows

## 🤝 Contributing

1. **Fork the repository**
2. **Create a feature branch**: `git checkout -b feature/amazing-feature`
3. **Make your changes** and add tests
4. **Run the test suite**: `npm test` (in relevant directories)
5. **Submit a pull request**

### Development Setup

```bash
# Install all dependencies
npm run install:all

# Run all services in development mode
npm run dev:all

# Run tests
npm run test:all
```

## 📄 License

This project is licensed under the MIT License - see the [LICENSE](LICENSE) file for details.

## 🙏 Acknowledgments

- **Maestro Team**: For the excellent UI testing framework
- **OpenAI**: For GPT-5 API and AI capabilities  
- **MCP Protocol**: For enabling seamless Cursor integration
- **Open Source Community**: For the tools and libraries that make this possible

---

**Built with ❤️ for the future of UI development automation**

> **Note**: This is a hackathon project demonstrating the potential of AI-powered UI testing. For production use, additional security, error handling, and scalability considerations should be implemented.