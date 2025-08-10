import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';
import OpenAI from 'openai';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

dotenv.config({ path: path.join(__dirname, '.env') });

async function testOpenAI() {
  console.log('🔍 Testing OpenAI connection...');
  
  // Check if API key is loaded
  if (!process.env.OPENAI_API_KEY) {
    console.error('❌ OPENAI_API_KEY not found in environment');
    console.log('Make sure you have a .env file in the project root with:');
    console.log('OPENAI_API_KEY=your_api_key_here');
    process.exit(1);
  }
  
  console.log('✅ API key loaded (starts with:', process.env.OPENAI_API_KEY.substring(0, 10) + '...)');
  
  const openai = new OpenAI({
    apiKey: process.env.OPENAI_API_KEY,
  });
  
  try {
    console.log('🚀 Making test request to OpenAI...');
    
    const completion = await openai.chat.completions.create({
      model: 'gpt-4o',
      messages: [
        {
          role: 'system',
          content: 'You are a helpful QA engineer analyzing test failures. Provide clear, actionable tasks for developers.'
        },
        {
          role: 'user',
          content: `You are reviewing test results and something failed. Based on the results, create a short list of tasks for the dev to fix it.

**Test Flow File:**
\`\`\`yaml
- launchApp
- assertVisible: "Generate Images"
- tapOn: "Generate Images"
\`\`\`

**Test Results:**
- Flow Name: test-flow
- Exit Code: 1
- Passed Steps: 2
- Failed Steps: 1
- Skipped Steps: 0

**Error Details:**
Element not found: Text matching regex: Generate Images

Please provide a concise list of actionable tasks for the developer to fix this issue.`
        }
      ],
      max_tokens: 300,
      temperature: 0.3
    });

    const response = completion.choices[0]?.message?.content;
    
    console.log('✅ OpenAI connection successful!');
    console.log('\n📋 AI Analysis Response:');
    console.log('=' .repeat(50));
    console.log(response);
    console.log('=' .repeat(50));
    
    console.log('\n🎉 Test completed successfully!');
    console.log('The OpenAI integration is working and will analyze failed Maestro tests.');
    
  } catch (error) {
    console.error('❌ OpenAI request failed:');
    console.error('Error:', error.message);
    
    if (error.status === 401) {
      console.log('\n💡 This looks like an authentication error.');
      console.log('Please check that your OpenAI API key is correct.');
    } else if (error.status === 429) {
      console.log('\n💡 Rate limit exceeded. Try again in a moment.');
    } else if (error.status === 400) {
      console.log('\n💡 Bad request. The model or request format might be incorrect.');
    }
    
    process.exit(1);
  }
}

testOpenAI().catch(console.error);